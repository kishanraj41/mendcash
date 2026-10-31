import fs from "fs";
import path from "path";
import { loadConfig } from "../src/config";
import { cardOrderBody, processChargebackBody } from "../src/paypal/chargeback";
import { createFetchClient } from "../src/paypal/http";
import { PayPalApiError, PayPalRest } from "../src/paypal/rest";
import { CATALOG } from "../src/scenario/catalog";
import { buildScenario, stableStringify } from "../src/scenario/planted";

const root = path.resolve(__dirname, "..");
const fixtures = path.join(root, "fixtures");

function writeOffline(): { disputes: number; injections: number } {
  const scenario = buildScenario();
  fs.mkdirSync(fixtures, { recursive: true });
  fs.writeFileSync(path.join(fixtures, "scenario.json"), stableStringify(scenario));
  fs.writeFileSync(
    path.join(fixtures, "ground_truth.json"),
    stableStringify({
      version: 1,
      cases: scenario.disputes.map((row) => row.expected),
    }),
  );
  return {
    disputes: scenario.disputes.length,
    injections: scenario.disputes.filter((row) => row.expected.injection).length,
  };
}

async function liveSeed(): Promise<void> {
  const config = loadConfig();
  if (!config.paypal.configured) {
    throw new Error("SEED_LIVE=1 but PAYPAL_CLIENT_ID or PAYPAL_CLIENT_SECRET is missing.");
  }
  const rest = new PayPalRest({ config, http: createFetchClient() });
  const scenario = buildScenario();
  const created: Array<{ disputeId: string; orderId: string; captureId: string; amount: string; reason: string }> = [];
  console.log("Live seed creates sandbox card orders and chargebacks. It does not print credentials.");
  for (const [index, row] of scenario.disputes.entries()) {
    const item = {
      id: `seed-${index + 1}`,
      title: row.order.purchase_units[0].description,
      amount: row.order.purchase_units[0].amount.value,
      kind: row.order.purchase_units[0].shipping ? ("physical" as const) : ("digital" as const),
    };
    const reference = `mendcash-seed-${String(index + 1).padStart(2, "0")}`;
    try {
      const order = (await rest.json("POST", "/v2/checkout/orders", cardOrderBody({
        item,
        reference,
        card: config.paypal.testCard,
      }), { "PayPal-Request-Id": reference })) as {
        id?: string;
        purchase_units?: Array<{ payee?: { merchant_id?: string }; payments?: { captures?: Array<{ id?: string; network_transaction_reference?: { id?: string } }> } }>;
        payment_source?: { card?: { brand?: string } };
      };
      const capture = order.purchase_units?.[0]?.payments?.captures?.[0];
      const merchantId = config.paypal.merchantId || order.purchase_units?.[0]?.payee?.merchant_id || "";
      if (!order.id || !capture?.id || !merchantId) throw new Error("Order response was missing capture or merchant id.");
      const due = row.dispute.seller_response_due_date || new Date(Date.now() + 10 * 86_400_000).toISOString();
      const responseDate = Date.parse(due) > Date.now() ? due : new Date(Date.now() + 10 * 86_400_000).toISOString();
      const chargeback = (await rest.json(
        "POST",
        "/v2/customer-support/process-chargeback",
        processChargebackBody({
          merchantId,
          captureId: capture.id,
          amount: row.dispute.dispute_amount.value,
          reasonCode: row.dispute.external_reason_code,
          notes: row.expected.injection
            ? row.dispute.evidences.find((item) => item.source === "SUBMITTED_BY_BUYER")?.notes || "Injection test"
            : row.dispute.evidences.find((item) => item.source === "SUBMITTED_BY_BUYER")?.notes || item.title,
          responseDate,
          receiveDate: new Date().toISOString(),
          cardBrand: order.payment_source?.card?.brand || "VISA",
          networkTransactionId: capture.network_transaction_reference?.id,
        }),
        { "PayPal-Request-Id": `${reference}-cb` },
      )) as { dispute_id?: string };
      if (!chargeback.dispute_id) throw new Error("process-chargeback did not return dispute_id.");
      created.push({
        disputeId: chargeback.dispute_id,
        orderId: order.id,
        captureId: capture.id,
        amount: row.dispute.dispute_amount.value,
        reason: row.dispute.reason,
      });
      console.log(`created ${chargeback.dispute_id} order ${order.id} amount ${row.dispute.dispute_amount.value} ${row.dispute.external_reason_code}`);
    } catch (error) {
      const debug = error instanceof PayPalApiError ? ` debug_id=${error.debugId || "none"} status=${error.status}` : "";
      console.error(`FAIL at case ${index + 1}:${debug} ${error instanceof Error ? error.message : "error"}`);
      throw error;
    }
  }
  fs.writeFileSync(
    path.join(fixtures, "live-seed-result.json"),
    stableStringify({ createdAt: new Date().toISOString(), created, catalog: CATALOG.map((item) => item.id) }),
  );
  console.log(`live_disputes: ${created.length}`);
  console.log("PayPal can take about 40 seconds to list a new dispute. Ids above came from process-chargeback.");
}

async function main(): Promise<void> {
  const offline = writeOffline();
  console.log("mode: offline fixtures");
  console.log(`disputes: ${offline.disputes}`);
  console.log(`injection_cases: ${offline.injections}`);
  console.log("ground_truth: fixtures/ground_truth.json");
  console.log("scenario: fixtures/scenario.json");
  if (process.env.SEED_LIVE === "1" || process.argv.includes("--live")) {
    await liveSeed();
    console.log("mode: live sandbox seed finished");
  } else {
    console.log("live: skipped (set SEED_LIVE=1 to create sandbox chargebacks)");
  }
  console.log("OK");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "seed failed");
  console.log("FAIL");
  process.exit(1);
});
