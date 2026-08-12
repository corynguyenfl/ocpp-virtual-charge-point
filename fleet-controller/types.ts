export type ConnState = "connecting" | "connected" | "disconnected";
export type TxState = "idle" | "preparing" | "charging" | "faulted";
export type Direction = "out" | "in" | "err";
export type OcppVersion = "1.6" | "2.0.1" | "2.1";

export interface Tail {
  dir: Direction;
  action: string;
  summary: string;
}

export interface ChargerRecord {
  uid: number;
  id: string;
  ver: OcppVersion;
  wsUrl: string;
  port: number;
  maxChargeRateA: number;
  quirks: string[];
  conn: ConnState;
  tx: TxState;
  meter: number; // Wh
  txId: number | null;
  since: number; // epoch ms, last (re)spawn time
  tail: Tail | null;
}

export interface LogEntry {
  key: string;
  cpUid: number;
  cpId: string;
  dir: Direction;
  action: string;
  summary: string;
  raw: string;
  time: number; // epoch ms
}

export interface QuirkInfo {
  name: string;
  description: string;
  implemented: boolean;
}

export interface ScenarioInfo {
  name: string;
  hotkey: string;
  description: string;
  durationMs: number;
  unported: boolean;
  unportedReason?: string;
}

export interface ActiveScenario {
  name: string;
  description: string;
  startedAt: number;
  endsAt: number;
}

export interface LaunchRequest {
  count: number;
  pattern: string;
  wsUrl: string;
  ver: OcppVersion;
  staggerSeconds: number;
  quirks: string[];
  maxChargeRateA: number;
}

export interface FleetSnapshot {
  chargers: ChargerRecord[];
  scenario: ActiveScenario | null;
  quirks: QuirkInfo[];
  quirkEnv: string;
}

export type StreamMessage =
  | { type: "log"; entry: LogEntry }
  | { type: "fleet"; snapshot: FleetSnapshot };
