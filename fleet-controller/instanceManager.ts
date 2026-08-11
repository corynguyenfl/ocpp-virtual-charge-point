import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import * as path from "node:path";
import * as readline from "node:readline";
import { InstanceLogParser } from "./logParser";
import type {
  ChargerRecord,
  LaunchRequest,
  LogEntry,
  OcppVersion,
  QuirkInfo,
} from "./types";

const REPO_ROOT = path.resolve(__dirname, "..");
const ENTRY_BY_VERSION: Record<OcppVersion, string> = {
  "1.6": "index_16.ts",
  "2.0.1": "index_201.ts",
  "2.1": "index_21.ts",
};

// The `autel-start-schedule` name is the only one src/v16/messages/*
// actually branches on today (see src/vendorQuirks.ts). The other two exist
// here purely as UI placeholders per the design handoff - toggling them for
// real still restarts instances with the env var set, it's just that no
// message handler reacts to that name yet.
export const KNOWN_QUIRKS: QuirkInfo[] = [
  {
    name: "autel-start-schedule",
    description:
      "Rejects SetChargingProfile when startSchedule is missing, as real Autel units do.",
    implemented: true,
  },
  {
    name: "abb-heartbeat-drift",
    description: "Sends Heartbeat 8-12% off the negotiated interval.",
    implemented: false,
  },
  {
    name: "kempower-meter-gap",
    description:
      "Skips one MeterValues out of every eight during a transaction.",
    implemented: false,
  },
];

interface Spec {
  id: string;
  ver: OcppVersion;
  wsUrl: string;
  port: number;
  quirks: string[];
}

interface Instance {
  spec: Spec;
  record: ChargerRecord;
  proc: ChildProcess | null;
  parser: InstanceLogParser;
  killedByController: boolean;
}

/**
 * Owns the fleet of VCP child processes: spawns/kills them, parses their
 * stdout into log entries + state-machine signals, and proxies /execute.
 * This is the "fleet-controller" the design handoff calls for - VCP
 * instances share no memory, so this is the only place fleet-wide state
 * and scenario orchestration can live.
 */
export class InstanceManager extends EventEmitter {
  private instances = new Map<number, Instance>();
  private nextUid = 1;
  private lastLaunch: { wsUrl: string; ver: OcppVersion } = {
    wsUrl: "ws://localhost:9000/ocpp",
    ver: "1.6",
  };

  launch(req: LaunchRequest): ChargerRecord[] {
    const created: ChargerRecord[] = [];
    for (let i = 0; i < req.count; i++) {
      const idx = i + 1;
      const id = req.pattern
        .replace("{n:03}", String(idx).padStart(3, "0"))
        .replace("{n}", String(idx));
      const uid = this.nextUid++;
      const port = 9100 + uid;
      const spec: Spec = {
        id,
        ver: req.ver,
        wsUrl: req.wsUrl,
        port,
        quirks: req.quirks,
      };
      const delayMs =
        req.staggerSeconds > 0
          ? (i / req.count) * req.staggerSeconds * 1000
          : 0;
      const record = this.register(uid, spec);
      created.push(record);
      setTimeout(() => this.spawnProcess(uid), delayMs);
    }
    this.lastLaunch = { wsUrl: req.wsUrl, ver: req.ver };
    return created;
  }

  private register(uid: number, spec: Spec): ChargerRecord {
    const record: ChargerRecord = {
      uid,
      id: spec.id,
      ver: spec.ver,
      wsUrl: spec.wsUrl,
      port: spec.port,
      quirks: spec.quirks,
      conn: "connecting",
      tx: "idle",
      meter: 0,
      txId: null,
      since: Date.now(),
      tail: null,
    };
    this.instances.set(uid, {
      spec,
      record,
      proc: null,
      parser: new InstanceLogParser(),
      killedByController: false,
    });
    return record;
  }

  private spawnProcess(uid: number): void {
    const inst = this.instances.get(uid);
    if (!inst) return;
    const { spec } = inst;
    const entry = ENTRY_BY_VERSION[spec.ver];
    const env = {
      ...process.env,
      WS_URL: spec.wsUrl,
      CP_ID: spec.id,
      ADMIN_PORT: String(spec.port),
      VENDOR_QUIRKS: spec.quirks.join(","),
    };
    const proc = spawn("npx", ["tsx", entry], { cwd: REPO_ROOT, env });
    inst.proc = proc;
    inst.killedByController = false;
    inst.record.conn = "connecting";
    inst.record.since = Date.now();
    this.emitFleetChange();

    const rl = readline.createInterface({ input: proc.stdout });
    rl.on("line", (line) => this.handleLine(uid, line));
    const rlErr = readline.createInterface({ input: proc.stderr });
    rlErr.on("line", (line) => this.handleLine(uid, line));

    proc.on("exit", () => {
      const current = this.instances.get(uid);
      if (!current || current.proc !== proc) return; // already replaced
      current.proc = null;
      current.record.conn = "disconnected";
      current.record.tx = "idle";
      current.record.txId = null;
      this.emitFleetChange();
    });
  }

  private handleLine(uid: number, line: string): void {
    const inst = this.instances.get(uid);
    if (!inst) return;
    const { entry, signals } = inst.parser.parseLine(line, uid, inst.record.id);
    if (entry) this.emit("log", entry satisfies LogEntry);

    let changed = false;
    for (const signal of signals) {
      switch (signal.kind) {
        case "traffic":
          if (inst.record.conn !== "connected") {
            inst.record.conn = "connected";
            changed = true;
          }
          break;
        case "txPreparing":
          inst.record.tx = "preparing";
          changed = true;
          break;
        case "txStarted":
          inst.record.tx = "charging";
          inst.record.txId = signal.txId;
          changed = true;
          break;
        case "txStopped":
          inst.record.tx = "idle";
          inst.record.txId = null;
          changed = true;
          break;
        case "fault":
          inst.record.tx = "faulted";
          changed = true;
          break;
        case "clearFault":
          if (inst.record.tx === "faulted") {
            inst.record.tx = "idle";
            changed = true;
          }
          break;
        case "meter":
          inst.record.meter = signal.valueWh;
          changed = true;
          break;
        case "closed":
          inst.record.conn = "disconnected";
          changed = true;
          break;
      }
    }
    if (entry) {
      inst.record.tail = {
        dir: entry.dir,
        action: entry.action,
        summary: entry.summary,
      };
      changed = true;
    }
    if (changed) this.emitFleetChange();
  }

  /** Kills the process (if running) without clearing the fleet record. */
  private killProcess(uid: number): void {
    const inst = this.instances.get(uid);
    if (!inst?.proc) return;
    inst.killedByController = true;
    inst.proc.kill("SIGTERM");
    inst.proc = null;
    inst.record.conn = "disconnected";
    inst.record.tx = "idle";
    inst.record.txId = null;
  }

  /** Kills and respawns one instance with its existing identity (id/port/wsUrl/quirks unchanged). */
  restart(uid: number, delayMs = 0): void {
    const inst = this.instances.get(uid);
    if (!inst) return;
    this.killProcess(uid);
    this.emitFleetChange();
    setTimeout(() => this.spawnProcess(uid), delayMs);
  }

  /** Permanently removes an instance (used when tearing down a whole fleet). */
  remove(uid: number): void {
    this.killProcess(uid);
    this.instances.delete(uid);
    this.emitFleetChange();
  }

  /** Kills every spawned child process. Node does not do this automatically
   * on parent exit, so the server must call this on SIGINT/SIGTERM or every
   * restart leaks orphaned VCP processes. */
  shutdown(): void {
    for (const uid of this.uids()) this.killProcess(uid);
  }

  executeOn(uid: number, action: string, payload: unknown): Promise<void> {
    const inst = this.instances.get(uid);
    if (!inst) throw new Error(`No such instance: ${uid}`);
    if (inst.record.conn === "disconnected") {
      throw new Error(`Instance ${inst.record.id} is disconnected`);
    }
    return fetch(`http://localhost:${inst.spec.port}/execute`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, payload }),
    }).then((res) => {
      if (!res.ok)
        throw new Error(`/execute on ${inst.record.id} returned ${res.status}`);
    });
  }

  /**
   * Quirks are launch-time env vars (src/vendorQuirks.ts reads them once at
   * module load), so there's no live toggle - applying a fleet-wide quirk
   * change means restarting every running instance with the new
   * VENDOR_QUIRKS value. Staggered lightly so a full fleet doesn't all
   * drop at once.
   */
  setFleetQuirks(quirks: string[]): number {
    const all = Array.from(this.instances.values());
    all.forEach((inst, i) => {
      inst.spec.quirks = quirks;
      inst.record.quirks = quirks;
      this.restart(inst.record.uid, i * 150);
    });
    return all.length;
  }

  records(): ChargerRecord[] {
    return Array.from(this.instances.values()).map((i) => i.record);
  }

  uids(): number[] {
    return Array.from(this.instances.keys());
  }

  aliveUids(): number[] {
    return Array.from(this.instances.values())
      .filter((i) => i.record.conn !== "disconnected")
      .map((i) => i.record.uid);
  }

  cloneTemplate(): { wsUrl: string; ver: OcppVersion } {
    const any = Array.from(this.instances.values())[0];
    return any ? { wsUrl: any.spec.wsUrl, ver: any.spec.ver } : this.lastLaunch;
  }

  quirkEnvString(): string {
    const names = new Set<string>();
    for (const inst of Array.from(this.instances.values())) {
      for (const q of inst.spec.quirks) names.add(q);
    }
    return Array.from(names).join(",");
  }

  private emitFleetChange(): void {
    this.emit("change");
  }
}
