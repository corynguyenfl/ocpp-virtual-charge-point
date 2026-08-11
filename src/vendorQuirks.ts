/**
 * Toggleable real-charger deviations from strict OCPP spec behavior, e.g.
 * "Autel rejects SetChargingProfile without startSchedule". Off by default
 * so this simulator behaves like a spec-compliant charger unless a specific
 * quirk is requested - not every CSMS under test should be held to one
 * vendor's strictness.
 *
 * Enable via VENDOR_QUIRKS=autel-start-schedule,other-quirk-name
 */
const enabledQuirks = new Set(
  (process.env.VENDOR_QUIRKS ?? "")
    .split(",")
    .map((q) => q.trim())
    .filter(Boolean),
);

export const isQuirkEnabled = (name: string): boolean =>
  enabledQuirks.has(name);
