import { closeMandates, customIdFor, grantMandates, issueReceipts, signCheckout, type MandateBundle, type ProofVerdict } from "../mandate/ap2";
import type { DemoKeys } from "../mandate/keys";
import type { Decision } from "../money/decision";
import { centsToMoney, moneyToCents } from "../money/format";
import { CATALOG } from "./catalog";
import type { FixtureDispute, FixtureOrder } from "./planted";

export const DEMO_MERCHANT = { id: "MERCHANT-MC-1", name: "MendCash Test Store" };

export type AgenticExpected = { disputeId: string; verdict: ProofVerdict; decision: Decision; agentClaim: boolean; pdf: boolean };
export type AgenticCase = { expected: AgenticExpected; dispute: FixtureDispute; order: FixtureOrder; bundle: MandateBundle | null };

type Spec = {
  itemId: string;
  allowed: string[];
  maxUsd: string;
  instruction: string;
  text: string;
  reason: "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED" | "OTHER";
  code: string;
  tracking: boolean;
  tamper?: "receipt";
  expiredBeforeOrder?: boolean;
  noMandate?: boolean;
  expect: { verdict: ProofVerdict; decision: Decision };
};

const SPECS: Spec[] = [
  {
    itemId: "stickers", allowed: ["stickers", "poster"], maxUsd: "20.00", instruction: "Get me something to decorate my laptop, under $20.",
    text: "I never agreed to this purchase. My AI shopping assistant bought it on its own.", reason: "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED", code: "4853",
    tracking: true, expect: { verdict: "authorized", decision: "contest" },
  },
  {
    itemId: "logo-pack", allowed: ["logo-pack"], maxUsd: "75.00", instruction: "Buy the logo pack for the new site when it is under $75.",
    text: "I didn't buy this. My assistant agent ordered it without asking me.", reason: "OTHER", code: "4837",
    tracking: false, expect: { verdict: "authorized", decision: "contest" },
  },
  {
    itemId: "brand-kit", allowed: ["logo-pack", "brand-kit"], maxUsd: "50.00", instruction: "Pick up a logo pack or brand kit, max $50.",
    text: "My agent spent way more than I allowed it to.", reason: "OTHER", code: "4837",
    tracking: false, expect: { verdict: "outside_mandate", decision: "accept" },
  },
  {
    itemId: "mug", allowed: ["mug"], maxUsd: "40.00", instruction: "Reorder the enamel mug this week.",
    text: "That permission had expired. My AI agent should not have bought anything.", reason: "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED", code: "4853",
    tracking: true, expiredBeforeOrder: true, expect: { verdict: "outside_mandate", decision: "accept" },
  },
  {
    itemId: "poster", allowed: ["poster"], maxUsd: "30.00", instruction: "Order one A3 poster.",
    text: "I don't recognize this order from my assistant.", reason: "OTHER", code: "4837",
    tracking: false, tamper: "receipt", expect: { verdict: "integrity_failure", decision: "accept" },
  },
  {
    itemId: "stickers", allowed: [], maxUsd: "0.00", instruction: "",
    text: "My AI bot bought these stickers, not me. They also look nothing like the photo.", reason: "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED", code: "4853",
    tracking: true, noMandate: true, expect: { verdict: "no_mandate", decision: "contest" },
  },
];

const ISSUED = Date.parse("2026-10-30T15:00:00.000Z") / 1000;
const ORDERED = Date.parse("2026-10-31T16:00:00.000Z") / 1000;
const CREATED = "2026-10-31T17:39:09.000Z";
const DUE = "2026-11-11T04:59:59.000Z";

function usd(value: string) {
  return { currency_code: "USD", value: centsToMoney(moneyToCents(value)) };
}

/** Six agent-purchase disputes: two authorized, two outside the mandate, one tampered record, one with no mandate. */
export function buildAgenticScenario(keys: DemoKeys): AgenticCase[] {
  return SPECS.map((spec, index) => {
    const n = String(index + 1).padStart(4, "0");
    const item = CATALOG.find((row) => row.id === spec.itemId)!;
    const orderId = `MCORDAG${n}X`;
    const captureId = `MCCAPAG${n}X`;
    const disputeId = `PP-R-AG-${n}`;
    const cents = moneyToCents(item.amount);
    const fee = Math.round(cents * 0.029) + 30;
    let bundle: MandateBundle | null = null;
    if (!spec.noMandate) {
      const exp = spec.expiredBeforeOrder ? ORDERED - 3600 : ISSUED + 7 * 86_400;
      const titles = (ids: string[]) => ids.map((id) => ({ id, title: CATALOG.find((row) => row.id === id)!.title }));
      const open = grantMandates(keys, {
        subject: "demo-buyer",
        instruction: spec.instruction,
        merchant: DEMO_MERCHANT,
        items: titles(spec.allowed),
        quantity: 1,
        maxCents: moneyToCents(spec.maxUsd),
        currency: "USD",
        iat: ISSUED,
        exp,
      });
      const checkoutJwt = signCheckout(keys, {
        id: `chk_ag_${n}`,
        merchant: DEMO_MERCHANT,
        item: { id: item.id, title: item.title },
        unitCents: cents,
        quantity: 1,
        currency: "USD",
        iat: ORDERED - 60,
      });
      const closed = closeMandates(keys, { checkoutJwt, payee: DEMO_MERCHANT, instrument: "PayPal sandbox test card", iat: ORDERED - 30, exp: ORDERED + 900 });
      const receipts = issueReceipts(keys, {
        closedCheckout: closed.closedCheckout,
        closedPayment: closed.closedPayment,
        orderId: spec.tamper === "receipt" ? "MCORDAG9999X" : orderId,
        captureId,
        iat: ORDERED,
      });
      bundle = {
        version: 1,
        transactionId: closed.transactionId,
        openCheckout: open.openCheckout,
        openPayment: open.openPayment,
        checkoutJwt,
        closedCheckout: closed.closedCheckout,
        closedPayment: closed.closedPayment,
        checkoutReceipt: receipts.checkoutReceipt,
        paymentReceipt: receipts.paymentReceipt,
        paypal: { orderId, captureId, customId: customIdFor(closed.transactionId), createdAt: new Date(ORDERED * 1000).toISOString() },
        instruction: spec.instruction,
        steps: [
          { at: new Date(ISSUED * 1000).toISOString(), step: "mandate", detail: "Buyer signed open checkout and payment mandates" },
          { at: new Date((ORDERED - 30) * 1000).toISOString(), step: "agent", detail: `Agent signed closed mandates for ${item.title}` },
          { at: new Date(ORDERED * 1000).toISOString(), step: "order", detail: `PayPal order ${orderId} with custom_id ap2:<transaction_id>` },
        ],
        createdAt: new Date(ORDERED * 1000).toISOString(),
        origin: "replay-fixture",
      };
    }
    const tracking = spec.tracking ? { carrier: "USPS", number: `9400AG${n}0000001` } : null;
    const base = `https://api-m.sandbox.paypal.com/v1/customer/disputes/${disputeId}`;
    const requested = spec.reason === "OTHER" ? ["OTHER"] : ["PROOF_OF_FULFILLMENT", "OTHER"];
    const order: FixtureOrder = {
      id: orderId,
      intent: "CAPTURE",
      status: "COMPLETED",
      purchase_units: [
        {
          reference_id: `mc-ag-${index + 1}`,
          description: item.title,
          ...(bundle ? { custom_id: customIdFor(bundle.transactionId) } : {}),
          amount: usd(item.amount),
          payee: { email_address: "merchant@example.com", merchant_id: DEMO_MERCHANT.id },
          ...(tracking ? { shipping: { trackers: [{ id: `${captureId}-${tracking.number}`, status: "SHIPPED", carrier: tracking.carrier, tracking_number: tracking.number }] } } : {}),
          payments: {
            captures: [
              {
                id: captureId,
                status: "COMPLETED",
                amount: usd(item.amount),
                final_capture: true,
                seller_receivable_breakdown: { gross_amount: usd(item.amount), paypal_fee: usd(centsToMoney(fee)), net_amount: usd(centsToMoney(cents - fee)) },
              },
            ],
          },
        },
      ],
      create_time: new Date(ORDERED * 1000).toISOString(),
      update_time: new Date(ORDERED * 1000).toISOString(),
    };
    const dispute: FixtureDispute = {
      dispute_id: disputeId,
      create_time: CREATED,
      update_time: CREATED,
      reason: spec.reason,
      status: "WAITING_FOR_SELLER_RESPONSE",
      dispute_state: "REQUIRED_ACTION",
      dispute_amount: usd(item.amount),
      dispute_life_cycle_stage: "CHARGEBACK",
      dispute_channel: "EXTERNAL",
      external_reason_code: spec.code,
      seller_response_due_date: DUE,
      disputed_transactions: [
        {
          buyer_transaction_id: `MCBUYAG${n}X`,
          seller_transaction_id: captureId,
          create_time: new Date(ORDERED * 1000).toISOString(),
          transaction_status: "HELD",
          gross_amount: usd(item.amount),
          buyer: { payer_id: `PAYAG${n}`, name: "Test Buyer" },
          seller: { email: "merchant@example.com", merchant_id: DEMO_MERCHANT.id, name: DEMO_MERCHANT.name },
          seller_protection_eligible: false,
        },
      ],
      evidences: [
        { evidence_type: "CREATE", notes: spec.text, source: "SUBMITTED_BY_BUYER", date: CREATED, dispute_life_cycle_stage: "CHARGEBACK" },
        ...requested.map((type) => ({ evidence_type: type, source: "REQUESTED_FROM_SELLER", date: CREATED, dispute_life_cycle_stage: "CHARGEBACK" })),
      ],
      offer: { buyer_requested_amount: usd(item.amount) },
      refund_details: { allowed_refund_amount: usd(item.amount) },
      fund_movements: [{ party: "RECEIVER", amount: usd(centsToMoney(cents - fee)), initiated_time: CREATED, type: "DEBIT", reason: "HOLD_PLACED" }],
      allowed_response_options: { accept_claim: { accept_claim_types: ["REFUND"] } },
      links: [
        { href: base, rel: "self", method: "GET" },
        { href: `${base}/accept-claim`, rel: "accept_claim", method: "POST" },
        { href: `${base}/provide-evidence`, rel: "provide_evidence", method: "POST" },
      ],
      extensions: { mendcash_simulated_deadline: true, mendcash_order_id: orderId },
    };
    return {
      expected: { disputeId, verdict: spec.expect.verdict, decision: spec.expect.decision, agentClaim: true, pdf: spec.expect.verdict === "authorized" },
      dispute,
      order,
      bundle,
    };
  });
}
