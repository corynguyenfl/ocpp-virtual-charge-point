import type { InstanceManager } from "./instanceManager";
import type { ActiveScenario, ScenarioInfo } from "./types";

export const SCENARIOS: ScenarioInfo[] = [
  {
    name: "blackout",
    hotkey: "b",
    description:
      "Controller closes all instances' WS connections, staggers restarts over 30-60s (power outage)",
    durationMs: 45_000,
    unported: false,
  },
  {
    name: "target-failover",
    hotkey: "t",
    description:
      "Controller disconnects and reconnects 20% of instances (target server restart)",
    durationMs: 15_000,
    unported: false,
  },
  {
    name: "rolling-restart",
    hotkey: "r",
    description:
      "Controller restarts instances one by one with 100ms delay (firmware update)",
    durationMs: 20_000,
    unported: false,
  },
  {
    name: "surge",
    hotkey: "s",
    description:
      "Controller spawns N new instances (up to the 200 launch cap) within 10 seconds (fleet expansion)",
    durationMs: 10_000,
    unported: false,
  },
  {
    name: "peak-hour",
    hotkey: "p",
    description: "Charging probability jumps to 80% for 5 minutes (rush hour)",
    durationMs: 300_000,
    unported: true,
    unportedReason:
      "Needs an autonomous-session-probability mode on VCP instances - they only act on incoming CSMS commands or admin /execute calls, they don't self-drive random sessions.",
  },
  {
    name: "idle-night",
    hotkey: "n",
    description: "Charging probability drops to 1% for 5 minutes (night hours)",
    durationMs: 300_000,
    unported: true,
    unportedReason:
      "Needs an autonomous-session-probability mode on VCP instances - they only act on incoming CSMS commands or admin /execute calls, they don't self-drive random sessions.",
  },
];

const LAUNCH_CAP = 200;

function randomBetween(a: number, b: number): number {
  return a + Math.random() * (b - a);
}

function pickRandomSubset<T>(items: T[], fraction: number): T[] {
  const count = Math.ceil(items.length * fraction);
  return [...items].sort(() => Math.random() - 0.5).slice(0, count);
}

/**
 * Runs the four scenarios that port cleanly onto independent VCP processes
 * (see design_handoff_vcp_fleet_manager - peak-hour/idle-night are excluded,
 * they require an autonomous-session mode this repo's VCP doesn't have).
 * Tracks the active scenario and its pending timers so Abort can cancel
 * them and reconnect anything still down.
 */
export class ScenarioRunner {
  private active: ActiveScenario | null = null;
  private pendingTimers: NodeJS.Timeout[] = [];
  private affectedUids = new Set<number>();

  constructor(private manager: InstanceManager) {}

  getActive(): ActiveScenario | null {
    return this.active;
  }

  run(name: string, targetUids: number[]): ActiveScenario {
    const info = SCENARIOS.find((s) => s.name === name);
    if (!info) throw new Error(`Unknown scenario: ${name}`);
    if (info.unported) {
      throw new Error(
        info.unportedReason ?? `Scenario "${name}" is not portable`,
      );
    }
    this.clearPending();
    this.affectedUids = new Set();

    if (name === "blackout") this.runBlackout(targetUids);
    else if (name === "target-failover") this.runTargetFailover(targetUids);
    else if (name === "rolling-restart") this.runRollingRestart(targetUids);
    else if (name === "surge") this.runSurge();

    const now = Date.now();
    this.active = {
      name: info.name,
      description: info.description,
      startedAt: now,
      endsAt: now + info.durationMs,
    };
    const endTimer = setTimeout(() => {
      if (this.active?.name === name) this.active = null;
    }, info.durationMs);
    this.pendingTimers.push(endTimer);
    return this.active;
  }

  abort(): void {
    this.clearPending();
    // Reconnect anything the scenario left down rather than waiting out
    // whatever staggered delay was still pending.
    for (const uid of Array.from(this.affectedUids)) {
      const record = this.manager.records().find((r) => r.uid === uid);
      if (record && record.conn === "disconnected") this.manager.restart(uid);
    }
    this.affectedUids = new Set();
    this.active = null;
  }

  private clearPending(): void {
    for (const t of this.pendingTimers) clearTimeout(t);
    this.pendingTimers = [];
  }

  private runBlackout(targetUids: number[]): void {
    for (const uid of targetUids) this.affectedUids.add(uid);
    // Every target drops immediately; restarts are staggered across a
    // 30-60s base delay plus jitter, mirroring demo/scenarios.ts's shape.
    const staggerWindow = Math.max(30_000, targetUids.length * 4);
    for (const uid of targetUids) {
      const restartDelay =
        randomBetween(30_000, 60_000) + Math.random() * staggerWindow;
      this.manager.restart(uid, restartDelay);
    }
  }

  private runTargetFailover(targetUids: number[]): void {
    const chosen = pickRandomSubset(targetUids, 0.2);
    for (const uid of chosen) {
      this.affectedUids.add(uid);
      this.manager.restart(uid, randomBetween(5_000, 15_000));
    }
  }

  private runRollingRestart(targetUids: number[]): void {
    const chosen = pickRandomSubset(targetUids, 0.2);
    chosen.forEach((uid, i) => {
      this.affectedUids.add(uid);
      const killAt = i * 100;
      const timer = setTimeout(() => {
        this.manager.restart(uid, randomBetween(2_000, 5_000));
      }, killAt);
      this.pendingTimers.push(timer);
    });
  }

  private runSurge(): void {
    const template = this.manager.cloneTemplate();
    const currentCount = this.manager.uids().length;
    const room = Math.max(0, LAUNCH_CAP - currentCount);
    const count = Math.min(12, room);
    if (count <= 0) return;
    this.manager.launch({
      count,
      pattern: "CP-SURGE-{n:03}",
      wsUrl: template.wsUrl,
      ver: template.ver,
      staggerSeconds: 10,
      quirks: [],
      maxChargeRateA: template.maxChargeRateA,
    });
  }
}
