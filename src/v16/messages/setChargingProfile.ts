import { z } from "zod";
import { type OcppCall, OcppIncoming } from "../../ocppMessage";
import { isQuirkEnabled } from "../../vendorQuirks";
import type { VCP } from "../../vcp";
import { ChargingProfileSchema, ConnectorIdSchema } from "./_common";

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
    vcp.respond(this.response(call, { status: "Accepted" }));
  };
}

export const setChargingProfileOcppMessage = new SetChargingProfileOcppMessage(
  "SetChargingProfile",
  SetChargingProfileReqSchema,
  SetChargingProfileResSchema,
);
