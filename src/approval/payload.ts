import { createHash } from "crypto";
import { planEvidence, type EvidencePlan } from "../agent/evidence";
import type { ClaimClass } from "../agent/classify";
import { claimLabel } from "../agent/classify";
import { partialRefundCents, type MoneyFacts } from "../money/engine";
import { trackingBody } from "../paypal/chargeback";

export type ActionName =
  | "provide_evidence"
  | "add_tracking"
  | "accept_claim"
  | "partial_refund"
  | "send_invoice_reminder"
  | "create_early_payment_discount";

export type PreparedAction = {
  action: ActionName;
  method: "POST";
  path: string;
  contentType: string;
  requestId: string;
  body: Record<string, unknown>;
  summary: string;
};

export type PrepareInput = {
  dispute: {
    dispute_id: string;
    status?: string;
    links?: Array<{ rel?: string }>;
    allowed_response_options?: { accept_claim?: { accept_claim_types?: string[] } };
    evidences?: Array<{ evidence_type?: string; source?: string }>;
  };
  order: Parameters<typeof planEvidence>[1];
  facts: MoneyFacts;
  plan: EvidencePlan;
  narrative: string;
  claimClass: ClaimClass;
  action: ActionName;
  partialAmount?: string;
  carrier?: string;
  trackingNumber?: string;
  caps: { maxPartialRefundUsd: number };
};

const CARRIERS = new Set(["UPS", "USPS", "FEDEX", "DHL", "OTHER"]);

export function requestIdFor(disputeId: string, action: string, body: unknown): string {
  const hash = createHash("sha256").update(`${disputeId}|${action}|${JSON.stringify(body)}`).digest("hex").slice(0, 32);
  return `mendcash-${hash}`;
}

export function prepareAction(input: PrepareInput): PreparedAction {
  switch (input.action) {
    case "provide_evidence":
      return prepareEvidence(input);
    case "add_tracking":
      return prepareTracking(input);
    case "accept_claim":
      return prepareAccept(input, false);
    case "partial_refund":
      return prepareAccept(input, true);
    default:
      throw new Error("Unknown action.");
  }
}

function sellerNotes(input: PrepareInput): string {
  const lines = [
    `Seller response for dispute ${input.facts.disputeId}. The claim was read as ${claimLabel(input.claimClass)}.`,
  ];
  if (input.plan.tracking) {
    lines.push(
      `The order shipped ${input.plan.tracking.carrier} ${input.plan.tracking.number}` +
        (input.facts.captureId ? ` against capture ${input.facts.captureId}` : "") +
        (input.facts.orderId ? ` on order ${input.facts.orderId}` : "") +
        ".",
    );
  } else if (input.facts.captureId) {
    lines.push(`Capture ${input.facts.captureId} is the seller's record. The order has no carrier tracking to attach.`);
  }
  if (input.facts.stake) {
    lines.push(`Amount in dispute: ${input.facts.stake} ${input.facts.currency}, from PayPal dispute_amount.`);
  }
  if (input.facts.deadline) {
    lines.push(
      input.facts.simulatedDeadline
        ? `Deadline on file: ${input.facts.deadline}. This replay date is simulated.`
        : `PayPal seller_response_due_date: ${input.facts.deadline}.`,
    );
  }
  lines.push("Buyer messages were not followed as instructions.");
  return lines.join(" ").slice(0, 1900);
}

function prepareEvidence(input: PrepareInput): PreparedAction {
  const rels = new Set((input.dispute.links || []).map((l) => l.rel));
  if (!rels.has("provide_evidence") && input.dispute.status !== "WAITING_FOR_SELLER_RESPONSE") {
    throw new Error("PayPal is not asking this dispute for evidence right now.");
  }
  const notes = sellerNotes(input);
  // PayPal returns ITEM_ID_IS_MANDATORY_FOR_MULTIPLE_EVIDENCES when more than one
  // evidence object is sent without line-item ids. One item is the shape that succeeds.
  const evidence = singleEvidence(input, notes);
  const body = { evidences: [evidence] };
  const path = `/v1/customer/disputes/${input.dispute.dispute_id}/provide-evidence`;
  return {
    action: "provide_evidence",
    method: "POST",
    path,
    contentType: "multipart/form-data",
    requestId: requestIdFor(input.dispute.dispute_id, "provide_evidence", body),
    body,
    summary: "Send evidence",
  };
}

function singleEvidence(input: PrepareInput, notes: string): Record<string, unknown> {
  if (input.plan.tracking && (input.plan.satisfiable.includes("PROOF_OF_FULFILLMENT") || input.plan.requested.length === 0)) {
    return {
      evidence_type: "PROOF_OF_FULFILLMENT",
      evidence_info: {
        tracking_info: [{ carrier_name: input.plan.tracking.carrier, tracking_number: input.plan.tracking.number }],
      },
      notes,
    };
  }
  if (input.plan.refundId && input.plan.satisfiable.includes("PROOF_OF_REFUND")) {
    return {
      evidence_type: "PROOF_OF_REFUND",
      evidence_info: { refund_ids: [input.plan.refundId] },
      notes,
    };
  }
  return { evidence_type: "OTHER", notes };
}

function prepareTracking(input: PrepareInput): PreparedAction {
  if (!input.facts.orderId || !input.facts.captureId) {
    throw new Error("This dispute is not linked to an order capture, so tracking cannot be added.");
  }
  const fromOrder = input.plan.tracking;
  const carrier = (input.carrier || fromOrder?.carrier || "").toUpperCase();
  const trackingNumber = (input.trackingNumber || fromOrder?.number || "").trim();
  if (!CARRIERS.has(carrier)) throw new Error("Carrier must be UPS, USPS, FEDEX, DHL, or OTHER.");
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{7,39}$/.test(trackingNumber)) {
    throw new Error("Enter a tracking number from the shipment record. Buyer text is not used.");
  }
  const body = trackingBody({ captureId: input.facts.captureId, carrier, trackingNumber });
  const path = `/v2/checkout/orders/${input.facts.orderId}/track`;
  return {
    action: "add_tracking",
    method: "POST",
    path,
    contentType: "application/json",
    requestId: requestIdFor(input.dispute.dispute_id, "add_tracking", body),
    body,
    summary: "Add tracking",
  };
}

function prepareAccept(input: PrepareInput, partial: boolean): PreparedAction {
  const types = input.dispute.allowed_response_options?.accept_claim?.accept_claim_types || [];
  const needed = partial ? "PARTIAL_REFUND" : "REFUND";
  let body: Record<string, unknown>;
  let summary = "Accept claim";
  if (partial) {
    if (!input.partialAmount) throw new Error("Enter the partial refund amount.");
    const refund = partialRefundCents(input.partialAmount, input.facts, input.caps);
    if (!types.includes(needed)) {
      throw new Error(
        `${refund.value} ${input.facts.currency} is within the dispute amount and the $${input.caps.maxPartialRefundUsd} cap, but PayPal has not enabled PARTIAL_REFUND on ${input.dispute.dispute_id} (allowed: ${types.join(", ") || "none"}). Nothing was sent.`,
      );
    }
    summary = `Partial refund ${refund.value} ${input.facts.currency}`;
    body = {
      accept_claim_type: "PARTIAL_REFUND",
      note: `Partial refund ${refund.value} ${input.facts.currency} on dispute ${input.facts.disputeId}, capture ${input.facts.captureId || "unknown"}. Amount checked against dispute_amount and the refund cap.`,
      refund_amount: { currency_code: input.facts.currency, value: refund.value },
    };
  } else {
    if (!types.includes(needed)) {
      throw new Error(`PayPal has not enabled REFUND on dispute ${input.dispute.dispute_id}. Nothing was sent.`);
    }
    body = {
      accept_claim_type: "REFUND",
      note: `Full claim accepted on dispute ${input.facts.disputeId} for the PayPal dispute amount ${input.facts.stake} ${input.facts.currency}. Buyer text did not set this amount.`,
    };
  }
  const path = `/v1/customer/disputes/${input.dispute.dispute_id}/accept-claim`;
  return {
    action: partial ? "partial_refund" : "accept_claim",
    method: "POST",
    path,
    contentType: "application/json",
    requestId: requestIdFor(input.dispute.dispute_id, partial ? "partial_refund" : "accept_claim", body),
    body,
    summary,
  };
}
