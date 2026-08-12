import * as path from "node:path";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { WebSocketServer } from "ws";
import { InstanceManager, KNOWN_QUIRKS } from "./instanceManager";
import { SCENARIOS, ScenarioRunner } from "./scenarios";
import type {
  FleetSnapshot,
  LaunchRequest,
  LogEntry,
  StreamMessage,
} from "./types";

const PORT = Number.parseInt(process.env.CONTROLLER_PORT ?? "8787", 10);
const PUBLIC_DIR = path.join(__dirname, "public");

const manager = new InstanceManager();
const scenarioRunner = new ScenarioRunner(manager);

function snapshot(): FleetSnapshot {
  return {
    chargers: manager.records(),
    scenario: scenarioRunner.getActive(),
    quirks: KNOWN_QUIRKS,
    quirkEnv: manager.quirkEnvString() || "—",
  };
}

function resolveTargets(body: {
  target?: "all" | "selected";
  uids?: number[];
}): number[] {
  if (body.target === "selected" && Array.isArray(body.uids)) return body.uids;
  return manager.uids();
}

const app = new Hono();

app.get("/api/fleet", (c) => c.json(snapshot()));

app.get("/api/scenarios", (c) => c.json(SCENARIOS));

app.post("/api/launch", async (c) => {
  const body = (await c.req.json()) as LaunchRequest;
  const count = Math.max(1, Math.min(200, Number(body.count) || 1));
  const created = manager.launch({
    count,
    pattern: body.pattern || "CP-{n:03}",
    wsUrl: body.wsUrl,
    ver: body.ver,
    staggerSeconds: Number(body.staggerSeconds) || 0,
    quirks: Array.isArray(body.quirks) ? body.quirks : [],
    maxChargeRateA: Number(body.maxChargeRateA) || 32,
  });
  return c.json({ created });
});

app.post("/api/instance/:uid/reconnect", (c) => {
  const uid = Number.parseInt(c.req.param("uid"), 10);
  manager.restart(uid);
  return c.json({ ok: true });
});

app.delete("/api/instance/:uid", (c) => {
  const uid = Number.parseInt(c.req.param("uid"), 10);
  manager.remove(uid);
  return c.json({ ok: true });
});

app.post("/api/execute", async (c) => {
  const body = (await c.req.json()) as {
    uid: number;
    action: string;
    payload: unknown;
  };
  try {
    await manager.executeOn(body.uid, body.action, body.payload);
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ ok: false, error: (err as Error).message }, 502);
  }
});

app.post("/api/quirks", async (c) => {
  const body = (await c.req.json()) as { quirks: string[] };
  const restarted = manager.setFleetQuirks(
    Array.isArray(body.quirks) ? body.quirks : [],
  );
  return c.json({ ok: true, restarted });
});

app.post("/api/scenario/abort", (c) => {
  scenarioRunner.abort();
  return c.json({ ok: true });
});

app.post("/api/scenario/:name", async (c) => {
  const name = c.req.param("name");
  const body = (await c.req.json().catch(() => ({}))) as {
    target?: "all" | "selected";
    uids?: number[];
  };
  try {
    const active = scenarioRunner.run(name, resolveTargets(body));
    return c.json({ ok: true, scenario: active });
  } catch (err) {
    return c.json({ ok: false, error: (err as Error).message }, 400);
  }
});

app.use("/*", serveStatic({ root: path.relative(process.cwd(), PUBLIC_DIR) }));

const server = serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`fleet-controller listening on http://localhost:${info.port}`);
});

const wss = new WebSocketServer({
  server: server as import("node:http").Server,
  path: "/api/stream",
});

function broadcast(msg: StreamMessage): void {
  const data = JSON.stringify(msg);
  for (const client of Array.from(wss.clients)) {
    if (client.readyState === client.OPEN) client.send(data);
  }
}

wss.on("connection", (socket) => {
  socket.send(
    JSON.stringify({
      type: "fleet",
      snapshot: snapshot(),
    } satisfies StreamMessage),
  );
});

manager.on("log", (entry: LogEntry) => broadcast({ type: "log", entry }));

function shutdown(): void {
  console.log("fleet-controller shutting down, killing spawned instances...");
  manager.shutdown();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// Fleet state changes arrive in bursts (a scenario touching many
// instances); coalesce into one snapshot per tick instead of one
// broadcast per underlying change.
let fleetChangePending = false;
manager.on("change", () => {
  if (fleetChangePending) return;
  fleetChangePending = true;
  setTimeout(() => {
    fleetChangePending = false;
    broadcast({ type: "fleet", snapshot: snapshot() });
  }, 100);
});
