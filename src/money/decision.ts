import type { ClaimClass } from "../agent/classify";
import type { EvidencePlan } from "../agent/evidence";
import type { AgentProof } from "../mandate/ap2";
import { centsToMoney } from "./format";

export type Decision = "contest" | "accept" | "review" | "wait" | "done";

export type Recommendation = {
  decision: Decision;
  headline: string;
  reasons: Array<{ text: string; source: string }>;
};

export type DecisionInput = {
  status: string;
  outcome: string | null;
  claimClass: ClaimClass;
  stakeCents: number | null;
  currency: string;
  plan: EvidencePlan;
  proof: AgentProof | null;
  sellerSent: boolean;
  overdue: boolean;
  smallClaimCents: number;
};

/** Contest or accept, from records only. Code decides; the model never sees this. The merchant still approves every write. */
export function recommend(input: DecisionInput): Recommendation {
  const stake = input.stakeCents === null ? "unknown" : `${centsToMoney(input.stakeCents)} ${input.currency}`;
  if (input.status === "RESOLVED") {
    return {
      decision: "done",
      headline: `Resolved${input.outcome ? `: ${input.outcome.replaceAll("_", " ").toLowerCase()}` : ""}.`,
      reasons: [{ text: `PayPal status ${input.status}`, source: "PayPal dispute" }],
    };
  }
  if (input.sellerSent && input.status === "UNDER_REVIEW") {
    return {
      decision: "wait",
      headline: "Evidence is with PayPal. Nothing to do until PayPal decides.",
      reasons: [{ text: "Seller evidence is on the dispute and status is UNDER_REVIEW", source: "PayPal dispute" }],
    };
  }
  if (input.proof && input.proof.verdict !== "no_mandate") {
    if (input.proof.verdict === "authorized") {
      return {
        decision: "contest",
        headline: "Contest. The buyer's own signed mandate authorized this agent purchase.",
        reasons: [
          { text: `${input.proof.checks.length}/${input.proof.checks.length} mandate checks pass, including PayPal's order fingerprint`, source: "MendCash mandate check" },
          { text: "Attach the mandate verification PDF as evidence", source: "AP2 dispute evidence" },
        ],
      };
    }
    return {
      decision: "accept",
      headline: input.proof.verdict === "outside_mandate"
        ? "Accept. The agent went outside what the buyer signed, so contesting would argue against your own record."
        : "Accept and investigate. The mandate on file does not match PayPal's record.",
      reasons: input.proof.checks.filter((check) => !check.pass).map((check) => ({ text: `Failed: ${check.label}`, source: "MendCash mandate check" })),
    };
  }
  if (input.overdue) {
    return { decision: "accept", headline: "The response deadline has passed.", reasons: [{ text: "seller_response_due_date is in the past", source: "PayPal dispute" }] };
  }
  const strong =
    (input.plan.tracking && (input.claimClass === "item_not_received" || input.claimClass === "not_as_described")) ||
    (input.plan.refundId && input.claimClass === "credit_not_processed");
  if (strong) {
    return {
      decision: "contest",
      headline: "Contest. The order record answers this claim.",
      reasons: [
        input.plan.tracking
          ? { text: `Carrier tracking ${input.plan.tracking.carrier} ${input.plan.tracking.number}`, source: "Order trackers" }
          : { text: `Refund ${input.plan.refundId}`, source: "Order refunds" },
      ],
    };
  }
  if (input.plan.missing.length && input.stakeCents !== null && input.stakeCents <= input.smallClaimCents) {
    return {
      decision: "accept",
      headline: `Accept. ${stake} is under your small-claim threshold and PayPal asked for evidence the order cannot show.`,
      reasons: [
        { text: `Missing: ${input.plan.missing.join(", ")}`, source: "PayPal evidence request" },
        { text: `Threshold ${centsToMoney(input.smallClaimCents)} ${input.currency}`, source: "SMALL_CLAIM_USD" },
      ],
    };
  }
  return {
    decision: "review",
    headline: `Your call. ${stake} at stake and the record holds notes, not proof.`,
    reasons: [{ text: input.plan.missing.length ? `Missing: ${input.plan.missing.join(", ")}` : "No carrier tracking or refund id on the order", source: "Order record" }],
  };
}
