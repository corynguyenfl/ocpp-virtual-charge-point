import type { Direction, LogEntry } from "./types";

// winston's format.colorize() wraps the level word in ANSI codes; strip them
// before matching against the fixed message prefixes vcp.ts's logger.info
// calls actually use (see src/vcp.ts).
// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional - stripping the ESC that starts an ANSI code
const ANSI_RE = /\x1b\[[0-9;]*m/g;

const SENDING_PREFIX = "Sending message ➡️";
const RESPONDING_PREFIX = "Responding with ➡️";
const RECEIVE_PREFIX = "Receive message ⬅️";

export type Signal =
  | { kind: "traffic" } // any message at all - proves the WS is open
  | { kind: "txPreparing" }
  | { kind: "txStarted"; txId: number }
  | { kind: "txStopped"; txId: number | null }
  | { kind: "fault" }
  | { kind: "clearFault" }
  | { kind: "meter"; valueWh: number }
  | { kind: "closed" };

interface ParsedLine {
  entry: LogEntry | null;
  signals: Signal[];
}

function summarize(payload: unknown): string {
  let s: string;
  try {
    s = JSON.stringify(payload);
  } catch {
    s = String(payload);
  }
  return s.length > 96 ? `${s.slice(0, 96)}…` : s;
}

/**
 * Tracks per-instance message-id -> action correlation so CALLRESULT/
 * CALLERROR log lines (which carry no action name on the wire) can be
 * labeled with what they're actually a response to.
 */
export class InstanceLogParser {
  private outgoingCalls = new Map<string, string>(); // messageId -> action we sent
  private incomingCalls = new Map<string, string>(); // messageId -> action the CSMS sent us

  parseLine(line: string, cpUid: number, cpId: string): ParsedLine {
    const clean = line.replace(ANSI_RE, "");
    const time = Date.now();
    const signals: Signal[] = [];

    if (clean.includes("Connection closed.")) {
      signals.push({ kind: "closed" });
      return { entry: null, signals };
    }

    let dir: Direction;
    let jsonStart: number;
    if (clean.includes(SENDING_PREFIX)) {
      dir = "out";
      jsonStart = clean.indexOf(SENDING_PREFIX) + SENDING_PREFIX.length;
    } else if (clean.includes(RESPONDING_PREFIX)) {
      dir = "out";
      jsonStart = clean.indexOf(RESPONDING_PREFIX) + RESPONDING_PREFIX.length;
    } else if (clean.includes(RECEIVE_PREFIX)) {
      dir = "in";
      jsonStart = clean.indexOf(RECEIVE_PREFIX) + RECEIVE_PREFIX.length;
    } else {
      return { entry: null, signals };
    }

    const raw = clean.slice(jsonStart).trim();
    let arr: unknown;
    try {
      arr = JSON.parse(raw);
    } catch {
      return { entry: null, signals };
    }
    if (!Array.isArray(arr) || arr.length < 2) {
      return { entry: null, signals };
    }

    signals.push({ kind: "traffic" });

    const msgType = arr[0] as number;
    const messageId = arr[1] as string;
    let action = "";
    let payload: unknown = {};

    if (msgType === 2) {
      // CALL: [2, messageId, action, payload]
      action = String(arr[2]);
      payload = arr[3] ?? {};
      if (dir === "out") this.outgoingCalls.set(messageId, action);
      else this.incomingCalls.set(messageId, action);
      this.applyCallSignals(action, payload, dir, signals);
    } else if (msgType === 3) {
      // CALLRESULT: [3, messageId, payload]
      payload = arr[2] ?? {};
      const correlated =
        dir === "out"
          ? this.incomingCalls.get(messageId)
          : this.outgoingCalls.get(messageId);
      action = correlated ? `${correlated}Response` : "Response";
      if (dir === "in" && correlated) {
        this.applyResultSignals(correlated, payload, signals);
        this.outgoingCalls.delete(messageId);
      }
      if (dir === "out") this.incomingCalls.delete(messageId);
    } else if (msgType === 4) {
      // CALLERROR: [4, messageId, errorCode, errorDescription, errorDetails]
      action = "Error";
      payload = {
        errorCode: arr[2],
        errorDescription: arr[3],
        errorDetails: arr[4],
      };
      dir = "err";
    } else {
      return { entry: null, signals };
    }

    const entry: LogEntry = {
      key: `${cpUid}-${messageId}-${dir}`,
      cpUid,
      cpId,
      dir,
      action,
      summary: summarize(payload),
      raw,
      time,
    };
    return { entry, signals };
  }

  private applyCallSignals(
    action: string,
    payload: unknown,
    dir: Direction,
    signals: Signal[],
  ): void {
    const p = (payload ?? {}) as Record<string, unknown>;
    if (dir === "in" && action === "RemoteStartTransaction") {
      signals.push({ kind: "txPreparing" });
    } else if (dir === "in" && action === "RemoteStopTransaction") {
      signals.push({ kind: "txStopped", txId: numericOrNull(p.transactionId) });
    } else if (action === "StopTransaction") {
      signals.push({ kind: "txStopped", txId: numericOrNull(p.transactionId) });
    } else if (action === "StatusNotification") {
      const status = p.status;
      if (status === "Faulted") signals.push({ kind: "fault" });
      else if (
        status === "Available" ||
        status === "Charging" ||
        status === "Preparing"
      )
        signals.push({ kind: "clearFault" });
    } else if (action === "MeterValues") {
      const wh = extractMeterWh(p);
      if (wh !== null) signals.push({ kind: "meter", valueWh: wh });
    }
  }

  private applyResultSignals(
    originalAction: string,
    payload: unknown,
    signals: Signal[],
  ): void {
    const p = (payload ?? {}) as Record<string, unknown>;
    if (
      originalAction === "StartTransaction" &&
      typeof p.transactionId === "number"
    ) {
      signals.push({ kind: "txStarted", txId: p.transactionId });
    }
  }
}

function numericOrNull(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

function extractMeterWh(payload: Record<string, unknown>): number | null {
  const meterValue = payload.meterValue;
  if (!Array.isArray(meterValue) || meterValue.length === 0) return null;
  const first = meterValue[0] as Record<string, unknown>;
  const sampled = first?.sampledValue;
  if (!Array.isArray(sampled) || sampled.length === 0) return null;
  const value = (sampled[0] as Record<string, unknown>)?.value;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
