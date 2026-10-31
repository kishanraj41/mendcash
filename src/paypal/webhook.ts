import type { AppConfig } from "../config";
import type { PayPalRest } from "./rest";

export type PayPalHeaders = Record<string, string | undefined>;

export async function verifyWebhookSignature(
  rest: PayPalRest,
  config: AppConfig,
  headers: PayPalHeaders,
  event: unknown,
): Promise<boolean> {
  if (!config.paypal.webhookId) {
    throw new Error("PAYPAL_WEBHOOK_ID is not set.");
  }
  const body = {
    auth_algo: headers["paypal-auth-algo"] || "",
    cert_url: headers["paypal-cert-url"] || "",
    transmission_id: headers["paypal-transmission-id"] || "",
    transmission_sig: headers["paypal-transmission-sig"] || "",
    transmission_time: headers["paypal-transmission-time"] || "",
    webhook_id: config.paypal.webhookId,
    webhook_event: event,
  };
  const result = (await rest.json("POST", "/v1/notifications/verify-webhook-signature", body)) as {
    verification_status?: string;
  };
  return result?.verification_status === "SUCCESS";
}
