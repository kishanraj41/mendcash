import { buyerTextOf } from "../agent/evidence";

export const BUYER_PENDING_LABEL = "Waiting on PayPal";
export const BUYER_PENDING_DETAIL = "Waiting for PayPal to deliver buyer details…";

type TextDispute = Parameters<typeof buyerTextOf>[0];

export function buyerTextPending(dispute: TextDispute): boolean {
  return !buyerTextOf(dispute).trim();
}

/** A model read is a paid call. Skip it until PayPal has delivered buyer text, and never cache the empty case. */
export function shouldAnalyzeBuyer(
  dispute: TextDispute,
  analyze: boolean | "auto",
  member: boolean,
  cacheHit: boolean,
): boolean {
  if (buyerTextPending(dispute) || cacheHit || analyze === false) return false;
  return analyze === true || (analyze === "auto" && member);
}

export function newerListStatus(
  cached: { status: string; update_time?: string },
  listed: { status?: string; update_time?: string },
): { status: string; update_time?: string } {
  const listedStatus = listed.status || "";
  const listedMs = timeMs(listed.update_time);
  const cachedMs = timeMs(cached.update_time);
  if (listedStatus && listedMs > cachedMs) {
    return { status: listedStatus, update_time: listed.update_time || cached.update_time };
  }
  return { status: cached.status, update_time: cached.update_time };
}

export function listStatusTtlMs(status: string): number {
  if (status === "RESOLVED" || status === "CLOSED") return 60_000;
  return 15_000;
}

function timeMs(value: string | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
