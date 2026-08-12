export type ChargingProfilePurpose =
  | "ChargePointMaxProfile"
  | "TxDefaultProfile"
  | "TxProfile";

export interface StoredChargingProfile {
  connectorId: number; // 0 = whole charge point / every connector
  chargingProfileId: number;
  transactionId: number | null;
  stackLevel: number;
  chargingProfilePurpose: ChargingProfilePurpose;
  limitWatts: number;
}

export interface ClearFilter {
  id?: number | null;
  connectorId?: number | null;
  chargingProfilePurpose?: ChargingProfilePurpose | null;
  stackLevel?: number | null;
}

/**
 * Tracks every profile a CSMS has set at once and resolves the effective
 * power ceiling using real OCPP 1.6 purpose/stackLevel priority: for a given
 * connector, an active TxProfile (matching the live transaction) overrides
 * TxDefaultProfile; within either purpose the highest stackLevel wins;
 * ChargePointMaxProfile is a separate ceiling applied on top of whichever of
 * those wins - not an alternative to it. Deliberately still flat-cap *within*
 * each profile (see wattsFromSchedule in setChargingProfile.ts, which reduces
 * a profile to a single number from its first schedule period) - this store
 * adds correct combination *across* multiple simultaneous profiles, not
 * time-aware scheduling within one.
 */
export class ChargingProfileStore {
  private profiles: StoredChargingProfile[] = [];

  set(profile: StoredChargingProfile): void {
    // A profile with the same id, or already occupying the same
    // (connectorId, purpose, stackLevel) slot, is replaced outright - matches
    // how a real charge point treats a re-sent/updated profile.
    this.profiles = this.profiles.filter(
      (p) =>
        p.chargingProfileId !== profile.chargingProfileId &&
        !(
          p.connectorId === profile.connectorId &&
          p.chargingProfilePurpose === profile.chargingProfilePurpose &&
          p.stackLevel === profile.stackLevel
        ),
    );
    this.profiles.push(profile);
  }

  /** Returns how many profiles were actually removed. */
  clear(filter: ClearFilter): number {
    const before = this.profiles.length;
    this.profiles = this.profiles.filter((p) => {
      const matches =
        (filter.id == null || p.chargingProfileId === filter.id) &&
        (filter.connectorId == null || p.connectorId === filter.connectorId) &&
        (filter.chargingProfilePurpose == null ||
          p.chargingProfilePurpose === filter.chargingProfilePurpose) &&
        (filter.stackLevel == null || p.stackLevel === filter.stackLevel);
      return !matches;
    });
    return before - this.profiles.length;
  }

  /**
   * The effective wattage ceiling for a connector given whichever
   * transaction (if any) is currently active on it. Null means no
   * profile-based cap is in effect - combine separately with the charger's
   * own physical max.
   */
  effectiveLimitWatts(
    connectorId: number,
    transactionId: number | null,
  ): number | null {
    const forConnector = this.profiles.filter(
      (p) => p.connectorId === 0 || p.connectorId === connectorId,
    );

    const txProfile = highestStackLevel(
      forConnector.filter(
        (p) =>
          p.chargingProfilePurpose === "TxProfile" &&
          p.transactionId === transactionId,
      ),
    );
    const txDefault = highestStackLevel(
      forConnector.filter(
        (p) => p.chargingProfilePurpose === "TxDefaultProfile",
      ),
    );
    const connectorLimit = (txProfile ?? txDefault)?.limitWatts ?? null;

    const chargePointMax =
      highestStackLevel(
        forConnector.filter(
          (p) => p.chargingProfilePurpose === "ChargePointMaxProfile",
        ),
      )?.limitWatts ?? null;

    if (connectorLimit === null && chargePointMax === null) return null;
    return Math.min(
      connectorLimit ?? Number.POSITIVE_INFINITY,
      chargePointMax ?? Number.POSITIVE_INFINITY,
    );
  }
}

function highestStackLevel(
  profiles: StoredChargingProfile[],
): StoredChargingProfile | undefined {
  return profiles.reduce<StoredChargingProfile | undefined>(
    (best, p) => (!best || p.stackLevel > best.stackLevel ? p : best),
    undefined,
  );
}
