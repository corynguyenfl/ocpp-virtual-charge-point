import { z } from "zod";
import { type OcppCall, OcppIncoming } from "../../ocppMessage";
import { isQuirkEnabled } from "../../vendorQuirks";
import type { VCP } from "../../vcp";
import {
  ChargingProfileSchema,
  ConnectorIdSchema,
  wattsFromAmps,
} from "./_common";

const SetChargingProfileReqSchema = z.object({
  connectorId: ConnectorIdSchema,
  csChargingProfiles: ChargingProfileSchema,
});
type SetChargingProfileReqType = typeof SetChargingProfileReqSchema;

const SetChargingProfileResSchema = z.object({
  status: z.enum(["Accepted", "Rejected", "NotSupported"]),
});
type SetChargingProfileResType = typeof SetChargingProfileResSchema;

class SetChargingProfileOcppMessage extends OcppIncoming<
  SetChargingProfileReqType,
  SetChargingProfileResType
> {
  reqHandler = async (
    vcp: VCP,
    call: OcppCall<z.infer<SetChargingProfileReqType>>,
  ): Promise<void> => {
    const profile = call.payload.csChargingProfiles;
    // Real Autel chargers reject SetChargingProfile outright with
    // PropertyConstraintViolation when startSchedule is missing on an
    // Absolute profile (required by OCPP 1.6 spec, but not every CSMS
    // sends it - see ocpp16j-mqtt's create_charge_profile_request, fixed
    // after a real Autel unit rejected it). Reproducing this lets tests
    // catch that regression instead of only finding it against real hardware.
    if (
      isQuirkEnabled("autel-start-schedule") &&
      profile.chargingProfileKind === "Absolute" &&
      !profile.chargingSchedule?.startSchedule
    ) {
      vcp.respondError({
        messageId: call.messageId,
        errorCode: "PropertyConstraintViolation",
        errorDescription: "startSchedule must be set!",
        errorDetails: {},
      });
      return;
    }
    vcp.chargingProfiles.set({
      connectorId: call.payload.connectorId,
      chargingProfileId: profile.chargingProfileId,
      transactionId: profile.transactionId ?? null,
      stackLevel: profile.stackLevel,
      chargingProfilePurpose: profile.chargingProfilePurpose,
      limitWatts: wattsFromSchedule(profile.chargingSchedule),
    });
    vcp.respond(this.response(call, { status: "Accepted" }));
  };
}

function wattsFromSchedule(
  schedule: z.infer<typeof ChargingProfileSchema>["chargingSchedule"],
): number {
  const period = schedule.chargingSchedulePeriod[0];
  if (schedule.chargingRateUnit === "W") {
    return period.limit;
  }
  return wattsFromAmps(period.limit, period.numberPhases);
}

export const setChargingProfileOcppMessage = new SetChargingProfileOcppMessage(
  "SetChargingProfile",
  SetChargingProfileReqSchema,
  SetChargingProfileResSchema,
);
