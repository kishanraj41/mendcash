export function disputeStatusLabel(status: string, outcome?: string | null): string | null {
  if (status === "RESOLVED" || status === "CLOSED") {
    const label = status === "CLOSED" ? "Closed" : "Resolved";
    if (outcome && /SELLER/.test(outcome)) return `${label} · seller won`;
    if (outcome && /BUYER|RESOLVED_WITH_PAYOUT/.test(outcome)) return `${label} · buyer refunded`;
    return label;
  }
  return status === "UNDER_REVIEW" ? "Under review" : null;
}
