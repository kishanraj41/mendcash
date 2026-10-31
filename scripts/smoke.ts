import { loadConfig } from "../src/config";
import { createFetchClient, PayPalApiError } from "../src/paypal/http";
import { PayPalRest } from "../src/paypal/rest";
import { credentialReport, formatCredentialReport, type CredentialLine } from "../src/ops/report";
import { nodeTooOld } from "../src/runtime";

export function smokePlan(lines: CredentialLine[]): { paypal: boolean; nebius: boolean; webhookMissing: boolean } {
  const set = (name: CredentialLine["name"]) => lines.find((line) => line.name === name)?.state === "set";
  return {
    paypal: set("PAYPAL_CLIENT_ID") && set("PAYPAL_CLIENT_SECRET"),
    nebius: set("NEBIUS_API_KEY"),
    webhookMissing: !set("PAYPAL_WEBHOOK_ID"),
  };
}

async function paypalAuth(): Promise<void> {
  const config = loadConfig();
  const rest = new PayPalRest({ config, http: createFetchClient() });
  await rest.accessToken();
  console.log("paypal_auth: ok");
  if (config.paypal.webhookId) {
    try {
      await rest.json("GET", `/v1/notifications/webhooks/${encodeURIComponent(config.paypal.webhookId)}`);
      console.log("paypal_webhook: ok");
    } catch (error) {
      const status = error instanceof PayPalApiError ? error.status : 0;
      console.log(`paypal_webhook: fail http ${status || "unknown"}`);
      throw new Error("PayPal webhook id was not found");
    }
  } else {
    console.log("paypal_webhook_id: missing (auth was still tested; status will refresh by polling)");
  }
  console.log(config.paypal.merchantId ? "paypal_merchant_id: set" : "paypal_merchant_id: will read from the order");
}

async function nebiusAuth(): Promise<void> {
  const config = loadConfig();
  const response = await fetch(`${config.nebius.baseUrl}/models`, {
    headers: { Authorization: `Bearer ${config.nebius.apiKey}` },
  });
  if (!response.ok) {
    console.log(`nebius_auth: fail http ${response.status}`);
    throw new Error("Nebius auth failed");
  }
  await response.text();
  console.log("nebius_auth: ok");
}

async function main(): Promise<void> {
  const tooOld = nodeTooOld();
  if (tooOld) {
    console.error(tooOld);
    console.log("FAIL");
    process.exit(1);
  }
  const lines = credentialReport(process.env);
  console.log(formatCredentialReport(lines));
  const plan = smokePlan(lines);
  let failed = lines.some((line) => line.state === "missing");
  if (plan.paypal) {
    try {
      await paypalAuth();
    } catch (error) {
      console.error(error instanceof Error ? error.message : "paypal auth failed");
      failed = true;
    }
  } else {
    console.log("paypal_auth: skipped (client id or secret missing)");
  }
  if (plan.nebius) {
    try {
      await nebiusAuth();
    } catch (error) {
      console.error(error instanceof Error ? error.message : "nebius auth failed");
      failed = true;
    }
  } else {
    console.log("nebius_auth: skipped (NEBIUS_API_KEY missing)");
  }
  if (failed) {
    console.log("FAIL");
    process.exit(1);
  }
  console.log("OK");
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "smoke failed");
    console.log("FAIL");
    process.exit(1);
  });
}
