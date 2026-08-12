// Vanilla JS, no framework/build step - the repo has no frontend tooling
// today and this is a single internal dashboard, not a multi-page app.
// Rendering strategy: full-region innerHTML rebuilds on structural changes
// (selection, view switch, fleet snapshots), but anything the user is
// actively typing into (filter box, payload textarea, launch fields) only
// triggers a *targeted* re-render of the dependent region next to it -
// never the input's own container - so typing never loses focus/cursor.

const OUT = "#7dd3fc";
const IN = "#a3e635";
const ERR = "#f87171";

const PAYLOADS = {
  MeterValues: {
    connectorId: 1,
    transactionId: 10041,
    meterValue: [
      {
        timestamp: new Date().toISOString(),
        sampledValue: [
          {
            value: "7420",
            measurand: "Energy.Active.Import.Register",
            unit: "Wh",
          },
        ],
      },
    ],
  },
  StatusNotification: {
    connectorId: 1,
    errorCode: "NoError",
    status: "Charging",
  },
  StartTransaction: {
    connectorId: 1,
    idTag: "RFID-AA07",
    meterStart: 0,
    timestamp: new Date().toISOString(),
  },
  StopTransaction: {
    // 0 is VCP's placeholder for "resolve to whatever transaction is
    // actually running" (see beforeSend in src/v16/messages/stopTransaction.ts).
    // A hardcoded fake id here would silently target no transaction at all -
    // the real one keeps its periodic MeterValues timer running forever.
    transactionId: 0,
    meterStop: 7420,
    timestamp: new Date().toISOString(),
    reason: "Local",
  },
  Heartbeat: {},
  BootNotification: {
    chargePointVendor: "OES",
    chargePointModel: "VCP-16",
    firmwareVersion: "1.6.0",
  },
  Authorize: { idTag: "RFID-AA07" },
  DataTransfer: {
    vendorId: "org.openenergysolutions",
    messageId: "ping",
    data: "{}",
  },
  FirmwareStatusNotification: { status: "Downloaded" },
  DiagnosticsStatusNotification: { status: "Uploaded" },
  SecurityEventNotification: {
    type: "SettingSystemTime",
    timestamp: new Date().toISOString(),
  },
  SignCertificate: { csr: "-----BEGIN CERTIFICATE REQUEST-----" },
};
const ACTIONS = Object.keys(PAYLOADS);
const QUICK_ACTIONS = [
  "MeterValues",
  "StatusNotification",
  "StopTransaction",
  "Heartbeat",
  "BootNotification",
  "Authorize",
];

const state = {
  chargers: [],
  scenario: null,
  quirks: [],
  quirkEnv: "—",
  scenarios: [],
  view: "fleet",
  filter: "",
  sel: null,
  checked: {},
  logFilter: "all",
  paused: false,
  log: [],
  launchOpen: false,
  action: "MeterValues",
  payload: JSON.stringify(PAYLOADS.MeterValues, null, 2),
  target: "all",
  detailRawKey: null,
  lc: {
    count: 12,
    pattern: "CP-NEIGH-{n:03}",
    wsUrl: "ws://localhost:9000/ocpp",
    ver: "1.6",
    staggerSeconds: 20,
    maxChargeRateA: 32,
    quirks: {},
  },
  msgRate: 0,
};
let recentMsgTimes = [];

function esc(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
}
function pad(n, w) {
  return String(n).padStart(w, "0");
}
function fmtTime(epochMs) {
  const d = new Date(epochMs);
  return `${pad(d.getHours(), 2)}:${pad(d.getMinutes(), 2)}:${pad(d.getSeconds(), 2)}.${pad(d.getMilliseconds(), 3)}`;
}
function fmtMs(ms) {
  if (ms <= 0) return "0s";
  const t = Math.round(ms / 1000);
  return t >= 60 ? `${Math.floor(t / 60)}m ${pad(t % 60, 2)}s` : `${t}s`;
}
function fmtUptime(sinceMs) {
  return fmtMs(Date.now() - sinceMs);
}
function connColor(c) {
  return c.conn === "connected"
    ? "#34d399"
    : c.conn === "connecting"
      ? "#fbbf24"
      : "#7b8695";
}
function dotColor(c) {
  if (c.conn !== "connected")
    return c.conn === "connecting" ? "#fbbf24" : "#4b5563";
  if (c.tx === "faulted") return "#f87171";
  if (c.tx === "charging") return "#a3e635";
  return "#34d399";
}
function txColor(c) {
  return c.tx === "charging"
    ? "#a3e635"
    : c.tx === "faulted"
      ? "#f87171"
      : c.tx === "preparing"
        ? "#38bdf8"
        : "#7b8695";
}
function dirColor(dir) {
  return dir === "in" ? IN : dir === "err" ? ERR : OUT;
}
function dirArrow(dir) {
  return dir === "in" ? "⬅" : dir === "err" ? "✕" : "➡";
}
function chargerById(uid) {
  return state.chargers.find((c) => c.uid === uid) || null;
}

async function api(path, opts) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `${path} returned ${res.status}`);
  return body;
}

// --- Header --------------------------------------------------------------

function renderHeader() {
  const counts = {
    connected: 0,
    charging: 0,
    connecting: 0,
    faulted: 0,
    disconnected: 0,
  };
  for (const c of state.chargers) {
    if (c.conn === "connecting") counts.connecting++;
    else if (c.conn === "disconnected") counts.disconnected++;
    else if (c.tx === "faulted") counts.faulted++;
    else if (c.tx === "charging") counts.charging++;
    else counts.connected++;
  }
  const el = document.getElementById("header");
  el.innerHTML = `
    <div style="display:flex;align-items:baseline;gap:8px;">
      <span class="mono wordmark">vcp</span><span class="subtitle">fleet manager</span>
    </div>
    <div class="tabgroup">
      <button data-act="go-view" data-view="fleet" class="${state.view === "fleet" ? "active" : ""}">Fleet</button>
      <button data-act="go-view" data-view="scenarios" class="${state.view === "scenarios" ? "active" : ""}">Scenarios</button>
    </div>
    <div class="state-counts mono">
      <span class="item" title="connected"><span class="dot" style="background:#34d399;"></span>${counts.connected}</span>
      <span class="item" title="charging"><span class="dot" style="background:#a3e635;"></span>${counts.charging}</span>
      <span class="item" title="connecting"><span class="dot" style="background:#fbbf24;"></span>${counts.connecting}</span>
      <span class="item" title="faulted"><span class="dot" style="background:#f87171;"></span>${counts.faulted}</span>
      <span class="item" title="disconnected"><span class="dot" style="background:#4b5563;"></span>${counts.disconnected}</span>
    </div>
    <div style="flex:0 1 24px;min-width:0;"></div>
    <div class="target-rate mono">
      <span class="label">target</span>
      <span class="ellipsis" style="color:#c3ccd8;">${esc(state.lc.wsUrl)}</span>
      <span class="divider"></span>
      <span class="label">msg/s</span>
      <span style="color:#38bdf8;min-width:30px;">${state.msgRate}</span>
    </div>
    <button data-act="open-launch" class="btn-primary">Launch fleet</button>
  `;
}

// --- Fleet overview --------------------------------------------------------

function filteredChargers() {
  const q = state.filter.trim().toLowerCase();
  if (!q) return state.chargers;
  return state.chargers.filter((c) =>
    `${c.id} ${c.conn} ${c.tx} ${c.quirks.join(" ")}`.toLowerCase().includes(q),
  );
}

function renderFleetToolbar() {
  const bar = document.getElementById("fleet-toolbar-info");
  if (!bar) return;
  const shown = filteredChargers();
  const selCount = Object.values(state.checked).filter(Boolean).length;
  bar.querySelector(".counts").textContent =
    `${shown.length} / ${state.chargers.length}`;
  bar.querySelector(".sel-count").textContent = `${selCount} selected`;
}

function fleetRowHtml(c, compact) {
  const on = state.sel === c.uid;
  const ck = !!state.checked[c.uid];
  const meterKwh = `${(c.meter / 1000).toFixed(2)} kWh`;
  const txLabel = c.tx === "charging" ? `charging #${c.txId ?? ""}` : c.tx;
  const tail = c.tail
    ? `<span style="color:${dirColor(c.tail.dir)};">${dirArrow(c.tail.dir)}</span> ${esc(c.tail.action)} ${esc(c.tail.summary)}`
    : "";
  const quirkChips = c.quirks
    .map((q) => `<span class="quirk-chip" title="${esc(q)}">${esc(q)}</span>`)
    .join("");
  return `
    <div class="fleet-row mono ${compact ? "compact" : ""} ${on ? "selected" : ""}" data-act="select-charger" data-uid="${c.uid}">
      <span class="checkbox ${ck ? "checked" : ""}" data-act="toggle-check" data-uid="${c.uid}">${ck ? "▪" : ""}</span>
      <span class="cp-cell">
        <span class="dot" style="background:${dotColor(c)};box-shadow:0 0 6px ${dotColor(c)}55;"></span>
        <span class="id">${esc(c.id)}</span>
      </span>
      <span class="cell-ver ${compact ? "hidden-in-compact" : ""}">${esc(c.ver)}</span>
      <span class="cell-conn ${compact ? "hidden-in-compact" : ""}" style="color:${connColor(c)};">${esc(c.conn)}</span>
      <span class="cell-tx" style="color:${txColor(c)};">${esc(txLabel)}</span>
      <span class="cell-meter">${meterKwh}</span>
      <span class="cell-quirks ${compact ? "hidden-in-compact" : ""}">${quirkChips}</span>
      <span class="cell-tail">${tail}</span>
    </div>
  `;
}

function renderFleetRows() {
  const rows = document.getElementById("fleet-rows");
  if (!rows) return;
  const compact = state.sel !== null;
  const shown = filteredChargers();
  rows.innerHTML = shown.map((c) => fleetRowHtml(c, compact)).join("");
  renderFleetToolbar();
}

function renderFleetSection() {
  const section = document.getElementById("fleet-section");
  if (state.view !== "fleet") {
    section.style.display = "none";
    return;
  }
  section.style.display = "flex";
  const compact = state.sel !== null;
  section.innerHTML = `
    <div class="toolbar" id="fleet-toolbar-info">
      <input class="mono" id="filter-input" placeholder="filter by id, state, quirk…" value="${esc(state.filter)}" />
      <span class="faint mono counts"></span>
      <div class="spacer"></div>
      <span class="faint mono sel-count"></span>
      <button data-act="clear-selection" class="btn-ghost">Clear</button>
    </div>
    <div class="fleet-head ${compact ? "compact" : ""}">
      <span></span><span>charge point</span>
      ${compact ? "" : "<span>v</span>"}
      ${compact ? "" : "<span>connection</span>"}
      <span>${compact ? "state" : "transaction"}</span>
      <span class="right">meter</span>
      ${compact ? "" : "<span>quirks</span>"}
      <span>last message</span>
    </div>
    <div class="fleet-rows" id="fleet-rows"></div>
  `;
  renderFleetRows();
  document.getElementById("filter-input").addEventListener("input", (e) => {
    state.filter = e.target.value;
    renderFleetRows();
  });
}

// --- Scenario control ------------------------------------------------------

function renderScenarioSection() {
  const section = document.getElementById("scenario-section");
  if (state.view !== "scenarios") {
    section.style.display = "none";
    return;
  }
  section.style.display = "block";
  const selCount = Object.values(state.checked).filter(Boolean).length;
  const bannerStyle = state.scenario ? "" : "display:none;";
  const scenarioCards = state.scenarios
    .map((s) => {
      const runBtn = s.unported
        ? `<button class="btn-blocked mono" title="${esc(s.unportedReason || "")}" disabled>Blocked</button>`
        : `<button class="btn-run mono" data-act="run-scenario" data-name="${esc(s.name)}">Run</button>`;
      const unportedNote = s.unported
        ? `<p class="scenario-unported mono">Not portable as-is — needs an autonomous-session-probability mode on VCP instances.</p>`
        : "";
      return `
      <div class="scenario-card">
        <div class="row">
          <span class="scenario-name mono">${esc(s.name)}</span>
          <span class="hotkey-chip mono">${esc(s.hotkey)}</span>
          <div class="spacer"></div>
          ${runBtn}
        </div>
        <p class="scenario-desc">${esc(s.description)}</p>
        ${unportedNote}
      </div>
    `;
    })
    .join("");
  const quirkRows = state.quirks
    .map((q) => {
      const on = !!state.lc.quirks[q.name];
      const appliedCount = state.chargers.filter((c) =>
        c.quirks.includes(q.name),
      ).length;
      return `
      <div class="quirk-row">
        <button class="quirk-switch ${on ? "on" : ""}" data-act="toggle-fleet-quirk" data-name="${esc(q.name)}"><span class="quirk-knob"></span></button>
        <span class="quirk-name mono">${esc(q.name)}</span>
        <span class="quirk-desc">${esc(q.description)}${q.implemented ? "" : " (no message-handler behavior wired up yet)"}</span>
        <span class="quirk-applied mono">${on ? `${appliedCount} instances` : "off"}</span>
      </div>
    `;
    })
    .join("");
  const enabledQuirkNames = Object.keys(state.lc.quirks).filter(
    (k) => state.lc.quirks[k],
  );

  section.innerHTML = `
    <div class="active-banner" style="${bannerStyle}">
      <div class="row">
        <span class="dot" style="width:8px;height:8px;background:#f87171;"></span>
        <span class="mono" style="font-size:13px;font-weight:700;color:#fca5a5;">${state.scenario ? esc(state.scenario.name) : ""}</span>
        <span style="font-size:12px;color:#9aa4b1;">${state.scenario ? esc(state.scenario.description) : ""}</span>
        <div class="spacer"></div>
        <span class="mono" style="font-size:12px;color:#e6eaf0;" id="scenario-countdown"></span>
        <button data-act="abort-scenario" class="btn-ghost" style="border-color:#7f1d1d;color:#fca5a5;">Abort</button>
      </div>
    </div>
    <div class="section-head">
      <h2>Scenarios</h2>
      <div class="rule"></div>
      <div class="tabgroup">
        <button data-act="set-target" data-target="all" class="${state.target === "all" ? "active" : ""}">All chargers</button>
        <button data-act="set-target" data-target="selected" class="${state.target === "selected" ? "active" : ""}">Selected (${selCount})</button>
      </div>
    </div>
    <div class="scenario-grid">${scenarioCards}</div>

    <div class="section-head spaced">
      <h2>Vendor quirks</h2>
      <div class="rule"></div>
      <span class="mono" style="font-size:11px;color:#8b96a5;">VENDOR_QUIRKS=</span>
      <span class="mono" style="font-size:11px;color:#e0a83a;">${esc(enabledQuirkNames.join(",") || "—")}</span>
    </div>
    <div class="quirk-list">${quirkRows}</div>

    <div class="section-head spaced">
      <h2>Power curve profiles</h2>
      <div class="rule"></div>
    </div>
    <div class="dropzone">
      <div style="flex:1;">
        <div style="font-size:12.5px;color:#9aa4b1;">Import a CSV curve to drive charging power across the fleet.</div>
        <div class="mono" style="font-size:11px;color:#8b96a5;margin-top:4px;">TimeStamp,Percent — applied to ${state.target === "selected" ? `${selCount} selected chargers` : "all chargers"}</div>
      </div>
      <button class="btn-small" disabled title="Not implemented yet">Choose CSV…</button>
    </div>
  `;
  updateScenarioCountdown();
}

function updateScenarioCountdown() {
  const el = document.getElementById("scenario-countdown");
  if (!el || !state.scenario) return;
  el.textContent = `resolves in ${fmtMs(state.scenario.endsAt - Date.now())}`;
}

// --- Charger detail ---------------------------------------------------------

function detailLogHtml(c) {
  const entries = state.log
    .filter((e) => e.cpUid === c.uid)
    .slice(-80)
    .reverse();
  return entries
    .map((e) => {
      const raw =
        state.detailRawKey === e.key
          ? `<pre class="log-raw mono" style="border-left-color:${dirColor(e.dir)};">${esc(e.raw)}</pre>`
          : "";
      return `
      <div class="log-row" data-act="toggle-raw" data-key="${esc(e.key)}">
        <span class="time mono">${fmtTime(e.time)}</span>
        <span class="mono" style="color:${dirColor(e.dir)};">${dirArrow(e.dir)}</span>
        <span class="msg">
          <span class="action mono" style="color:${dirColor(e.dir)};">${esc(e.action)}</span>
          <span class="summary mono">${esc(e.summary)}</span>
          ${raw}
        </span>
      </div>
    `;
    })
    .join("");
}

function renderDetail() {
  const aside = document.getElementById("detail-aside");
  const c = state.sel !== null ? chargerById(state.sel) : null;
  if (!c) {
    aside.className = "empty";
    aside.innerHTML = "";
    return;
  }
  aside.className = "";
  const status =
    c.tx === "charging"
      ? "Charging"
      : c.tx === "faulted"
        ? "Faulted"
        : c.tx === "preparing"
          ? "Preparing"
          : "Available";
  const quickButtons = QUICK_ACTIONS.map(
    (a) =>
      `<button data-act="quick-fire" data-action="${esc(a)}">${esc(a)}</button>`,
  ).join("");
  const actionOptions = ACTIONS.map(
    (a) =>
      `<option value="${esc(a)}" ${a === state.action ? "selected" : ""}>${esc(a)}</option>`,
  ).join("");
  let payloadStatus = "valid JSON";
  let payloadStatusColor = "#8b96a5";
  let validPayload = true;
  try {
    JSON.parse(state.payload);
  } catch (err) {
    payloadStatus = `invalid JSON — ${err.message}`;
    payloadStatusColor = ERR;
    validPayload = false;
  }

  aside.innerHTML = `
    <div class="detail-inner">
      <div class="detail-head">
        <div class="row">
          <span class="dot" style="width:8px;height:8px;background:${dotColor(c)};box-shadow:0 0 8px ${dotColor(c)}55;"></span>
          <span class="cp-id mono">${esc(c.id)}</span>
          <div class="spacer"></div>
          <button data-act="reconnect" data-uid="${c.uid}" class="btn-small">Reconnect</button>
          <button data-act="remove-charger" data-uid="${c.uid}" class="btn-small btn-danger">Remove</button>
          <button data-act="close-detail" class="btn-close">✕</button>
        </div>
        <div class="detail-grid">
          <div class="field"><span class="label">connection</span><span class="value mono" style="color:${connColor(c)};">${esc(c.conn)}</span></div>
          <div class="field"><span class="label">connector 1</span><span class="value mono" style="color:${txColor(c)};">${esc(status)}</span></div>
          <div class="field"><span class="label">txn id</span><span class="value mono">${c.txId ?? "—"}</span></div>
          <div class="field"><span class="label">meter</span><span class="value mono">${(c.meter / 1000).toFixed(2)} kWh</span></div>
        </div>
        <div class="detail-meta mono">
          <span>OCPP ${esc(c.ver)}</span><span class="sep">·</span><span>max ${c.maxChargeRateA}A</span><span class="sep">·</span><span>admin :${c.port}</span><span class="sep">·</span><span id="detail-uptime">uptime ${fmtUptime(c.since)}</span>
        </div>
      </div>
      <div class="quick-actions mono">${quickButtons}</div>
      <div class="detail-log" id="detail-log">${detailLogHtml(c)}</div>
      <div class="execute-form">
        <div class="row">
          <span class="mono" style="font-size:11px;color:#8b96a5;">POST /execute</span>
          <select id="action-select">${actionOptions}</select>
        </div>
        <textarea id="payload-textarea" class="mono" spellcheck="false">${esc(state.payload)}</textarea>
        <div class="footer">
          <span class="mono" id="payload-status" style="font-size:11px;color:${payloadStatusColor};">${esc(payloadStatus)}</span>
          <div class="spacer"></div>
          <button id="send-btn" data-act="send-execute" class="btn-send" ${validPayload ? "" : "disabled"}>Send</button>
        </div>
      </div>
    </div>
  `;

  document.getElementById("action-select").addEventListener("change", (e) => {
    state.action = e.target.value;
    state.payload = JSON.stringify(PAYLOADS[e.target.value] ?? {}, null, 2);
    renderDetail();
  });
  document.getElementById("payload-textarea").addEventListener("input", (e) => {
    state.payload = e.target.value;
    renderExecuteStatus();
  });
}

function renderExecuteStatus() {
  const statusEl = document.getElementById("payload-status");
  const sendBtn = document.getElementById("send-btn");
  if (!statusEl || !sendBtn) return;
  try {
    JSON.parse(state.payload);
    statusEl.textContent = "valid JSON";
    statusEl.style.color = "#8b96a5";
    sendBtn.disabled = false;
  } catch (err) {
    statusEl.textContent = `invalid JSON — ${err.message}`;
    statusEl.style.color = ERR;
    sendBtn.disabled = true;
  }
}

// --- Log rail ----------------------------------------------------------------

function renderRail() {
  const rail = document.getElementById("rail");
  rail.innerHTML = `
    <div class="rail-bar">
      <span class="title">fleet log</span>
      <div class="pillgroup">
        <button data-act="log-filter" data-filter="all" class="${state.logFilter === "all" ? "active" : ""}">all</button>
        <button data-act="log-filter" data-filter="out" class="${state.logFilter === "out" ? "active" : ""}">sent</button>
        <button data-act="log-filter" data-filter="in" class="${state.logFilter === "in" ? "active" : ""}">received</button>
        <button data-act="log-filter" data-filter="err" class="${state.logFilter === "err" ? "active" : ""}">errors</button>
      </div>
      <div class="spacer"></div>
      <span class="mono faint">${state.log.length} lines</span>
      <button data-act="toggle-pause" class="btn-pause mono ${state.paused ? "on" : ""}">${state.paused ? "resume" : "pause"}</button>
      <button data-act="clear-log" class="btn-ghost">clear</button>
    </div>
    <div class="rail-lines" id="rail-lines"></div>
  `;
  renderRailLines();
}

function renderRailLines() {
  const el = document.getElementById("rail-lines");
  if (!el) return;
  const lf = state.logFilter;
  const lines = state.log
    .filter((e) => lf === "all" || e.dir === lf)
    .slice(-120)
    .reverse();
  el.innerHTML = lines
    .map(
      (e) => `
    <div class="rail-line mono" data-act="select-from-rail" data-uid="${e.cpUid}">
      <span class="time">${fmtTime(e.time)}</span>
      <span class="cpid">${esc(e.cpId)}</span>
      <span style="color:${dirColor(e.dir)};">${dirArrow(e.dir)}</span>
      <span class="summary-cell"><span style="color:${dirColor(e.dir)};">${esc(e.action)}</span> ${esc(e.summary)}</span>
    </div>
  `,
    )
    .join("");
}

// --- Launch modal ------------------------------------------------------------

function launchPreview() {
  const lc = state.lc;
  const ids = [];
  for (let i = 1; i <= Math.min(3, lc.count); i++) {
    ids.push(lc.pattern.replace("{n:03}", pad(i, 3)).replace("{n}", String(i)));
  }
  const tail =
    lc.count > 3
      ? `  …  ${lc.pattern.replace("{n:03}", pad(lc.count, 3)).replace("{n}", String(lc.count))}`
      : "";
  return `${ids.join("  ")}${tail}   →   ${lc.wsUrl}   ocpp${lc.ver}   max ${lc.maxChargeRateA}A   admin :${9101}-${9100 + lc.count}`;
}

function renderLaunchPreview() {
  const strip = document.getElementById("launch-preview");
  const note = document.getElementById("launch-note");
  const btn = document.getElementById("launch-btn");
  if (!strip) return;
  strip.textContent = launchPreview();
  note.textContent = `${state.lc.count} processes, staggered over ${state.lc.staggerSeconds}s`;
  btn.textContent = `Launch ${state.lc.count}`;
}

function renderLaunchModal() {
  const overlay = document.getElementById("launch-modal");
  if (!state.launchOpen) {
    overlay.className = "modal-overlay hidden";
    overlay.innerHTML = "";
    return;
  }
  overlay.className = "modal-overlay";
  const versionPills = ["1.6", "2.0.1", "2.1"]
    .map(
      (v) =>
        `<button data-act="pick-version" data-ver="${v}" class="${state.lc.ver === v ? "active" : ""}">${v}</button>`,
    )
    .join("");
  const quirkChips = state.quirks
    .map(
      (q) =>
        `<button data-act="toggle-launch-quirk" data-name="${esc(q.name)}" class="quirk-toggle-chip mono ${state.lc.quirks[q.name] ? "on" : ""}">${esc(q.name)}</button>`,
    )
    .join("");

  overlay.innerHTML = `
    <div class="modal">
      <div class="modal-title">
        <span class="text">Launch fleet</span>
        <div class="spacer"></div>
        <button data-act="close-launch" class="btn-close">✕</button>
      </div>
      <div class="modal-body">
        <label>
          <span class="field-label">instances</span>
          <input id="lc-count" class="mono" value="${state.lc.count}" />
        </label>
        <label>
          <span class="field-label">id pattern</span>
          <input id="lc-pattern" class="mono wide-input" value="${esc(state.lc.pattern)}" />
        </label>
        <label class="span-2">
          <span class="field-label">target server (WS_URL)</span>
          <input id="lc-url" class="mono wide-input" value="${esc(state.lc.wsUrl)}" />
        </label>
        <div>
          <span class="field-label">ocpp version</span>
          <div class="pillgroup" style="width:fit-content;margin-top:5px;">${versionPills}</div>
        </div>
        <label>
          <span class="field-label">stagger (seconds)</span>
          <input id="lc-stagger" class="mono" value="${state.lc.staggerSeconds}" />
        </label>
        <label>
          <span class="field-label">max charge rate (A)</span>
          <input id="lc-max-amps" class="mono" value="${state.lc.maxChargeRateA}" title="This charger's physical ceiling (e.g. wired supply/breaker rating) - independent of whatever SetChargingProfile a CSMS later sends." />
        </label>
        <div class="span-2" style="display:flex;flex-direction:column;gap:6px;">
          <span class="field-label">vendor quirks on these instances</span>
          <div style="display:flex;flex-wrap:wrap;gap:6px;">${quirkChips}</div>
        </div>
        <div class="preview-strip mono" id="launch-preview"></div>
      </div>
      <div class="modal-footer">
        <span class="mono faint" id="launch-note"></span>
        <div class="spacer"></div>
        <button data-act="close-launch" class="btn-cancel">Cancel</button>
        <button data-act="do-launch" id="launch-btn" class="btn-launch"></button>
      </div>
    </div>
  `;
  renderLaunchPreview();

  document.getElementById("lc-count").addEventListener("input", (e) => {
    state.lc.count = Math.max(
      1,
      Math.min(200, Number.parseInt(e.target.value || "0", 10) || 1),
    );
    renderLaunchPreview();
  });
  document.getElementById("lc-pattern").addEventListener("input", (e) => {
    state.lc.pattern = e.target.value;
    renderLaunchPreview();
  });
  document.getElementById("lc-url").addEventListener("input", (e) => {
    state.lc.wsUrl = e.target.value;
    renderLaunchPreview();
    renderHeader();
  });
  document.getElementById("lc-stagger").addEventListener("input", (e) => {
    state.lc.staggerSeconds = Number.parseInt(e.target.value || "0", 10) || 0;
    renderLaunchPreview();
  });
  document.getElementById("lc-max-amps").addEventListener("input", (e) => {
    state.lc.maxChargeRateA =
      Math.max(1, Number.parseInt(e.target.value || "0", 10)) || 32;
    renderLaunchPreview();
  });
}

// --- Full render ---------------------------------------------------------

function renderAll() {
  renderHeader();
  document.getElementById("main").style.gridTemplateColumns =
    state.sel !== null
      ? "minmax(0,1fr) minmax(380px,460px)"
      : "minmax(0,1fr) 0px";
  renderFleetSection();
  renderScenarioSection();
  renderDetail();
  renderRail();
  renderLaunchModal();
}

// --- Actions ---------------------------------------------------------------

const actions = {
  "go-view": (t) => {
    state.view = t.dataset.view;
    renderAll();
  },
  "open-launch": () => {
    state.launchOpen = true;
    renderLaunchModal();
  },
  "close-launch": () => {
    state.launchOpen = false;
    renderLaunchModal();
  },
  "select-charger": (t) => {
    state.sel = Number(t.dataset.uid);
    renderAll();
  },
  "select-from-rail": (t) => {
    state.sel = Number(t.dataset.uid);
    state.view = "fleet";
    renderAll();
  },
  "close-detail": () => {
    state.sel = null;
    renderAll();
  },
  "toggle-check": (t, e) => {
    e.stopPropagation();
    const uid = Number(t.dataset.uid);
    state.checked[uid] = !state.checked[uid];
    renderFleetRows();
  },
  "clear-selection": () => {
    state.checked = {};
    renderFleetRows();
  },
  "set-target": (t) => {
    state.target = t.dataset.target;
    renderScenarioSection();
  },
  "run-scenario": async (t) => {
    const name = t.dataset.name;
    const uids =
      state.target === "selected"
        ? Object.keys(state.checked)
            .filter((k) => state.checked[k])
            .map(Number)
        : undefined;
    try {
      const res = await api(`/api/scenario/${name}`, {
        method: "POST",
        body: JSON.stringify({ target: state.target, uids }),
      });
      state.scenario = res.scenario;
      renderScenarioSection();
    } catch (err) {
      alert(err.message);
    }
  },
  "abort-scenario": async () => {
    await api("/api/scenario/abort", { method: "POST" });
    state.scenario = null;
    renderScenarioSection();
  },
  "toggle-fleet-quirk": async (t) => {
    const name = t.dataset.name;
    state.lc.quirks[name] = !state.lc.quirks[name];
    const enabled = Object.keys(state.lc.quirks).filter(
      (k) => state.lc.quirks[k],
    );
    renderScenarioSection();
    await api("/api/quirks", {
      method: "POST",
      body: JSON.stringify({ quirks: enabled }),
    });
  },
  "toggle-launch-quirk": (t) => {
    state.lc.quirks[t.dataset.name] = !state.lc.quirks[t.dataset.name];
    renderLaunchModal();
  },
  "pick-version": (t) => {
    state.lc.ver = t.dataset.ver;
    renderLaunchModal();
  },
  "do-launch": async () => {
    const quirks = Object.keys(state.lc.quirks).filter(
      (k) => state.lc.quirks[k],
    );
    await api("/api/launch", {
      method: "POST",
      body: JSON.stringify({
        count: state.lc.count,
        pattern: state.lc.pattern,
        wsUrl: state.lc.wsUrl,
        ver: state.lc.ver,
        staggerSeconds: state.lc.staggerSeconds,
        maxChargeRateA: state.lc.maxChargeRateA,
        quirks,
      }),
    });
    state.launchOpen = false;
    state.view = "fleet";
    renderAll();
  },
  reconnect: async (t) => {
    const uid = Number(t.dataset.uid);
    // Respawning the process takes a few seconds - show it immediately
    // rather than leaving the panel looking unresponsive until the next
    // fleet snapshot arrives.
    const c = chargerById(uid);
    if (c) {
      c.conn = "connecting";
      c.tx = "idle";
      c.txId = null;
      renderFleetRows();
      renderDetail();
    }
    await api(`/api/instance/${uid}/reconnect`, { method: "POST" });
  },
  "remove-charger": async (t) => {
    const uid = Number(t.dataset.uid);
    const c = chargerById(uid);
    if (
      !confirm(
        `Remove ${c ? c.id : "this charge point"}? This stops its process for good.`,
      )
    )
      return;
    await api(`/api/instance/${uid}`, { method: "DELETE" });
    state.chargers = state.chargers.filter((x) => x.uid !== uid);
    delete state.checked[uid];
    if (state.sel === uid) state.sel = null;
    renderAll();
  },
  "quick-fire": async (t) => {
    if (state.sel === null) return;
    const action = t.dataset.action;
    try {
      await api("/api/execute", {
        method: "POST",
        body: JSON.stringify({
          uid: state.sel,
          action,
          payload: PAYLOADS[action] ?? {},
        }),
      });
    } catch (err) {
      alert(err.message);
    }
  },
  "send-execute": async () => {
    if (state.sel === null) return;
    let payload;
    try {
      payload = JSON.parse(state.payload);
    } catch {
      return;
    }
    try {
      await api("/api/execute", {
        method: "POST",
        body: JSON.stringify({ uid: state.sel, action: state.action, payload }),
      });
    } catch (err) {
      alert(err.message);
    }
  },
  "toggle-raw": (t) => {
    const key = t.dataset.key;
    state.detailRawKey = state.detailRawKey === key ? null : key;
    const c = chargerById(state.sel);
    const logEl = document.getElementById("detail-log");
    if (logEl && c) logEl.innerHTML = detailLogHtml(c);
  },
  "log-filter": (t) => {
    state.logFilter = t.dataset.filter;
    renderRail();
  },
  "toggle-pause": () => {
    state.paused = !state.paused;
    renderRail();
  },
  "clear-log": () => {
    state.log = [];
    renderRail();
    if (state.sel !== null) renderDetail();
  },
};

document.body.addEventListener("click", (e) => {
  const t = e.target.closest("[data-act]");
  if (!t) return;
  const fn = actions[t.dataset.act];
  if (fn) fn(t, e);
});

// --- Live data: initial snapshot + WebSocket stream -------------------------

function applyFleetSnapshot(snapshot) {
  state.chargers = snapshot.chargers;
  state.scenario = snapshot.scenario;
  state.quirks = snapshot.quirks;
  state.quirkEnv = snapshot.quirkEnv;
  renderHeader();
  if (state.view === "fleet") renderFleetRows();
  if (state.view === "scenarios") renderScenarioSection();
  if (state.sel !== null) renderDetail();
}

function connectStream() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(`${proto}//${location.host}/api/stream`);
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === "fleet") {
      applyFleetSnapshot(msg.snapshot);
    } else if (msg.type === "log") {
      recentMsgTimes.push(Date.now());
      if (state.paused) return;
      state.log.push(msg.entry);
      if (state.log.length > 400) state.log.splice(0, state.log.length - 400);
      renderRailLines();
      const railCountEl = document.querySelector("#rail .faint");
      if (railCountEl) railCountEl.textContent = `${state.log.length} lines`;
      const sel = chargerById(state.sel);
      if (sel && msg.entry.cpUid === sel.uid) {
        const logEl = document.getElementById("detail-log");
        if (logEl) logEl.innerHTML = detailLogHtml(sel);
      }
    }
  };
  ws.onclose = () => setTimeout(connectStream, 2000);
}

async function loadScenarios() {
  state.scenarios = await api("/api/scenarios");
}

async function init() {
  const [snapshot] = await Promise.all([api("/api/fleet"), loadScenarios()]);
  applyFleetSnapshot(snapshot);
  renderAll();
  connectStream();
  setInterval(() => {
    const cutoff = Date.now() - 1000;
    recentMsgTimes = recentMsgTimes.filter((t) => t > cutoff);
    state.msgRate = recentMsgTimes.length;
    const rateEl = document.querySelector(".target-rate span:last-child");
    if (rateEl) rateEl.textContent = state.msgRate;
  }, 1000);
  setInterval(updateScenarioCountdown, 1000);
  setInterval(() => {
    const el = document.getElementById("detail-uptime");
    const c = chargerById(state.sel);
    if (el && c) el.textContent = `uptime ${fmtUptime(c.since)}`;
  }, 1000);
}

init();
