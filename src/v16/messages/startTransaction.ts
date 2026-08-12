import { z } from "zod";
import {
  type OcppCall,
  type OcppCallResult,
  OcppOutgoing,
} from "../../ocppMessage";
import { resolveTokenPlaceholder } from "../../tokenPlaceholder";
import type { VCP } from "../../vcp";
import {
  ConnectorIdSchema,
  IdTagInfoSchema,
  IdTokenSchema,
  wattsFromAmps,
} from "./_common";
import { meterValuesOcppMessage } from "./meterValues";
import { statusNotificationOcppMessage } from "./statusNotification";
import { stopTransactionOcppMessage } from "./stopTransaction";

// This charger's own physical ceiling (e.g. its wired supply/breaker
// rating) - independent of whatever SetChargingProfile a CSMS sends, the
// same way a real charger can't exceed its own hardware regardless of what
// it's told. Configurable per instance (each simulated charger is its own
// process) via MAX_CHARGE_RATE_A; 32A is a common single-phase Level 2 max.
const DEFAULT_MAX_CHARGE_RATE_A = 32;
const maxChargeRateA =
  Number(process.env.MAX_CHARGE_RATE_A) || DEFAULT_MAX_CHARGE_RATE_A;
const SIMULATED_MAX_POWER_W = wattsFromAmps(maxChargeRateA);

const StartTransactionReqSchema = z.object({
  connectorId: ConnectorIdSchema,
  idTag: IdTokenSchema,
  meterStart: z.number().int(),
  reservationId: z.number().int().nullish(),
  timestamp: z.string().datetime(),
});
type StartTransactionReqType = typeof StartTransactionReqSchema;

const StartTransactionResSchema = z.object({
  idTagInfo: IdTagInfoSchema,
  transactionId: z.number().int(),
});
type StartTransactionResType = typeof StartTransactionResSchema;

class StartTransactionOcppMessage extends OcppOutgoing<
  StartTransactionReqType,
  StartTransactionResType
> {
  beforeSend = (
    _vcp: VCP,
    payload: z.infer<StartTransactionReqType>,
  ): z.infer<StartTransactionReqType> => {
    return { ...payload, idTag: resolveTokenPlaceholder(payload.idTag) };
  };

  resHandler = async (
    vcp: VCP,
    call: OcppCall<z.infer<StartTransactionReqType>>,
    result: OcppCallResult<z.infer<StartTransactionResType>>,
  ): Promise<void> => {
    vcp.transactionManager.startTransaction(vcp, {
      transactionId: result.payload.transactionId,
      idTag: call.payload.idTag,
      connectorId: call.payload.connectorId,
      meterValuesCallback: async (transactionState) => {
        vcp.send(
          meterValuesOcppMessage.request({
            connectorId: call.payload.connectorId,
            transactionId: result.payload.transactionId,
            meterValue: [
              {
                timestamp: new Date().toISOString(),
                sampledValue: [
                  {
                    value: (transactionState.meterValue / 1000).toString(),
                    measurand: "Energy.Active.Import.Register",
                    unit: "kWh",
                  },
                  // Some CSMS integrations (e.g. ocpp16j-mqtt's serial
                  // bridge) only compute instantaneous power from a
                  // Power.Active.Import sample and ignore the energy
                  // register entirely - without this, they'd never see a
                  // charging rate for this transaction. Capped at this
                  // charger's own physical max AND the effective profile
                  // ceiling (real TxProfile/TxDefaultProfile/
                  // ChargePointMaxProfile priority - see
                  // vcp.chargingProfiles), so both "this charger can't
                  // physically exceed its wiring" and "a CSMS's
                  // load-shedding decision is visible in reported power"
                  // hold - the energy register above does NOT slow down to
                  // match, that would need tracking actual integrated
                  // energy instead of TransactionManager's fixed time-based
                  // ramp.
                  {
                    value: Math.min(
                      SIMULATED_MAX_POWER_W,
                      vcp.chargingProfiles.effectiveLimitWatts(
                        call.payload.connectorId,
                        result.payload.transactionId,
                      ) ?? Number.POSITIVE_INFINITY,
                    ).toString(),
                    measurand: "Power.Active.Import",
                    unit: "W",
                  },
                ],
              },
            ],
          }),
        );
      },
    });
    if (result.payload.idTagInfo.status !== "Accepted") {
      vcp.send(
        stopTransactionOcppMessage.request({
          transactionId: result.payload.transactionId,
          meterStop: 0,
          reason: "DeAuthorized",
          timestamp: new Date().toISOString(),
        }),
      );
      vcp.send(
        statusNotificationOcppMessage.request({
          connectorId: call.payload.connectorId,
          errorCode: "NoError",
          status: "Available",
        }),
      );
      return;
    }
  };
}

export const startTransactionOcppMessage = new StartTransactionOcppMessage(
  "StartTransaction",
  StartTransactionReqSchema,
  StartTransactionResSchema,
);
