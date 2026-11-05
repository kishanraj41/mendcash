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
  // Without PayPal's transmission headers there is nothing to verify, so do not ask PayPal.
  const required = ["paypal-auth-algo", "paypal-cert-url", "paypal-transmission-id", "paypal-transmission-sig", "paypal-transmission-time"] as const;
  if (required.some((name) => !headers[name])) return false;
  const body = {
    auth_algo: headers["paypal-auth-algo"] || "",
    cert_url: headers["paypal-cert-url"] || "",
    transmission_id: headers["paypal-transmission-id"] || "",
    transmission_sig: headers["paypal-transmission-sig"] || "",
    transmission_time: headers["paypal-transmission-time"] || "",
    webhook_id: config.paypal.webhookId,
    webhook_event: event,
  };
  try {
    const result = (await rest.json("POST", "/v1/notifications/verify-webhook-signature", body)) as {
      verification_status?: string;
    };
    return result?.verification_status === "SUCCESS";
  } catch (error) {
    // PayPal's validation text stays in the server log; the caller only learns the signature was not verified.
    console.error(error instanceof Error ? error.message : "Webhook verification call failed.");
    return false;
  }
}
