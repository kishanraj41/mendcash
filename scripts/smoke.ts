import { loadConfig } from "../src/config";
import { credentialReport, formatCredentialReport } from "../src/ops/report";

async function paypalAuth(): Promise<void> {
  const config = loadConfig();
  const basic = Buffer.from(`${config.paypal.clientId}:${config.paypal.clientSecret}`).toString("base64");
  const response = await fetch(`${config.paypal.baseUrl}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: "grant_type=client_credentials",
  });
  const body = (await response.json()) as { access_token?: string; expires_in?: number };
  if (!response.ok || !body.access_token) {
    console.log(`paypal_auth: fail http ${response.status}`);
    throw new Error("PayPal auth failed");
  }
  console.log(`paypal_auth: ok expires_in=${body.expires_in ?? "unknown"}`);
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
  const lines = credentialReport(process.env);
  console.log(formatCredentialReport(lines));
  if (lines.some((line) => line.state === "missing")) {
    console.log("FAIL");
    process.exit(1);
  }
  await paypalAuth();
  await nebiusAuth();
  console.log("OK");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "smoke failed");
  console.log("FAIL");
  process.exit(1);
});
