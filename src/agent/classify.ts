export const CLAIM_CLASSES = [
  "item_not_received",
  "not_as_described",
  "unauthorized",
  "credit_not_processed",
  "duplicate_charge",
  "canceled_recurring",
  "incorrect_amount",
  "other",
] as const;

export type ClaimClass = (typeof CLAIM_CLASSES)[number];

const REASON_MAP: Record<string, ClaimClass> = {
  MERCHANDISE_OR_SERVICE_NOT_RECEIVED: "item_not_received",
  MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED: "not_as_described",
  UNAUTHORISED: "unauthorized",
  UNAUTHORIZED: "unauthorized",
  CREDIT_NOT_PROCESSED: "credit_not_processed",
  DUPLICATE_TRANSACTION: "duplicate_charge",
  CANCELED_RECURRING_BILLING: "canceled_recurring",
  INCORRECT_AMOUNT: "incorrect_amount",
};

export function isClaimClass(value: string): value is ClaimClass {
  return (CLAIM_CLASSES as readonly string[]).includes(value);
}

export function classFromReason(reason: string | undefined): ClaimClass | null {
  if (!reason) return null;
  return REASON_MAP[reason] || null;
}

export function classFromText(text: string): ClaimClass {
  const cleaned = text.toLowerCase();
  if (/never authorized|did not authorize|didn't authorize|do not recognize|don't recognize|unauthori[sz]ed|fraudulent charge/.test(cleaned)) {
    return "unauthorized";
  }
  if (/never arrived|not received|didn't receive|did not receive|never got|not delivered|missing package|never shipped/.test(cleaned)) {
    return "item_not_received";
  }
  if (/not as described|wrong (item|color|size)|damaged|broken|different from|doesn't match|does not match|wrong size/.test(cleaned)) {
    return "not_as_described";
  }
  if (/charged twice|duplicate|double charged/.test(cleaned)) return "duplicate_charge";
  if (/credit not processed|refund (hasn't|has not|never)|still waiting for (a )?refund/.test(cleaned)) {
    return "credit_not_processed";
  }
  if (/cancel+ed.*(subscription|membership|recurring)|still (being )?charged/.test(cleaned)) {
    return "canceled_recurring";
  }
  if (/wrong amount|overcharged|incorrect amount/.test(cleaned)) return "incorrect_amount";
  return "other";
}

/** PayPal's reason code wins when it names a claim. Buyer text cannot override it. */
export function classifyClaim(reason: string | undefined, buyerText: string, modelClass?: string | null): ClaimClass {
  const fromReason = classFromReason(reason);
  if (fromReason) return fromReason;
  if (modelClass && isClaimClass(modelClass)) return modelClass;
  return classFromText(buyerText);
}

export function claimLabel(claim: ClaimClass): string {
  switch (claim) {
    case "item_not_received":
      return "Item not received";
    case "not_as_described":
      return "Not as described";
    case "unauthorized":
      return "Unauthorized";
    case "credit_not_processed":
      return "Credit not processed";
    case "duplicate_charge":
      return "Duplicate charge";
    case "canceled_recurring":
      return "Canceled recurring";
    case "incorrect_amount":
      return "Incorrect amount";
    default:
      return "Other";
  }
}
