import { z } from "zod";
import { type OcppCall, OcppIncoming } from "../../ocppMessage";
import type { VCP } from "../../vcp";
import { ConnectorIdSchema } from "./_common";

const ClearChargingProfileReqSchema = z.object({
  id: z.number().int().nullish(),
  connectorId: ConnectorIdSchema.nullish(),
  chargingProfilePurpose: z
    .enum(["ChargePointMaxProfile", "TxDefaultProfile", "TxProfile"])
    .nullish(),
  stackLevel: z.number().int().nullish(),
});
type ClearChargingProfileReqType = typeof ClearChargingProfileReqSchema;

const ClearChargingProfileResSchema = z.object({
  status: z.enum(["Accepted", "Unknown"]),
});
type ClearChargingProfileResType = typeof ClearChargingProfileResSchema;

class ClearChargingProfileOcppMessage extends OcppIncoming<
  ClearChargingProfileReqType,
  ClearChargingProfileResType
> {
  reqHandler = async (
    vcp: VCP,
    call: OcppCall<z.infer<ClearChargingProfileReqType>>,
  ): Promise<void> => {
    const filter = {
      id: call.payload.id ?? null,
      connectorId: call.payload.connectorId ?? null,
      chargingProfilePurpose: call.payload.chargingProfilePurpose ?? null,
      stackLevel: call.payload.stackLevel ?? null,
    };
    const anyFilterGiven = Object.values(filter).some((v) => v !== null);
    const removed = vcp.chargingProfiles.clear(filter);
    // "Unknown" means a *targeted* clear matched nothing; clearing
    // everything (no filter given) is always Accepted even if there was
    // nothing to remove.
    const status = anyFilterGiven && removed === 0 ? "Unknown" : "Accepted";
    vcp.respond(this.response(call, { status }));
  };
}

export const clearChargingProfileOcppMessage =
  new ClearChargingProfileOcppMessage(
    "ClearChargingProfile",
    ClearChargingProfileReqSchema,
    ClearChargingProfileResSchema,
  );
