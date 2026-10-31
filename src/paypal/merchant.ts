import type { PayPalRest } from "./rest";

export const MISSING_MERCHANT_ID =
  "PayPal did not include a merchant id. POST /v2/checkout/orders often omits payee, and GET /v2/checkout/orders/{id} did not have purchase_units[0].payee.merchant_id either. Set PAYPAL_MERCHANT_ID. No chargeback was filed.";

export function merchantIdFromOrder(order: unknown): string {
  if (!order || typeof order !== "object") return "";
  const units = (order as { purchase_units?: Array<{ payee?: { merchant_id?: string } }> }).purchase_units;
  const id = units?.[0]?.payee?.merchant_id;
  return typeof id === "string" ? id : "";
}

/** Prefer the env override. Otherwise read the create response, then GET the order. */
export async function orderWithMerchant(
  rest: PayPalRest,
  created: unknown,
  envMerchantId: string,
): Promise<{ merchantId: string; order: Record<string, unknown> }> {
  const order = created && typeof created === "object" ? (created as Record<string, unknown>) : {};
  if (envMerchantId) return { merchantId: envMerchantId, order };
  let merchantId = merchantIdFromOrder(order);
  const id = typeof order.id === "string" ? order.id : "";
  if (!merchantId && id) {
    const full = await rest.json("GET", `/v2/checkout/orders/${id}`);
    if (full && typeof full === "object") {
      merchantId = merchantIdFromOrder(full);
      return { merchantId, order: full as Record<string, unknown> };
    }
  }
  return { merchantId, order };
}
