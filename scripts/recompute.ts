/**
 * Independent money check for eval. This file does not import the app's money engine.
 * It reads the same PayPal fields and formats cents on its own.
 */

type Money = { currency_code?: string; value?: string };

export type Recomputed = {
  stake: string | null;
  allowedRefund: string | null;
  gross: string | null;
  fee: string | null;
  net: string | null;
  hold: string | null;
  deadline: string | null;
  currency: string;
  disputeId: string;
  captureId: string | null;
};

function cents(value: string): number {
  const trimmed = value.trim();
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) throw new Error(`Bad money ${trimmed}`);
  const neg = trimmed.startsWith("-");
  const unsigned = neg ? trimmed.slice(1) : trimmed;
  const [dollars, fraction = ""] = unsigned.split(".");
  const frac = (fraction + "000").slice(0, 3);
  let total = Number(dollars) * 100 + Number(frac.slice(0, 2));
  if (Number(frac[2]) >= 5) total += 1;
  return neg ? -total : total;
}

function money(total: number): string {
  const neg = total < 0;
  const abs = Math.abs(Math.trunc(total));
  return `${neg ? "-" : ""}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

function read(value: Money | undefined): { currency: string; cents: number } | null {
  if (!value?.value) return null;
  return { currency: value.currency_code || "USD", cents: cents(value.value) };
}

export function recompute(dispute: {
  dispute_id: string;
  dispute_amount?: Money;
  seller_response_due_date?: string;
  refund_details?: { allowed_refund_amount?: Money };
  fund_movements?: Array<{ amount?: Money; type?: string; reason?: string }>;
  disputed_transactions?: Array<{ seller_transaction_id?: string; gross_amount?: Money }>;
}, order: {
  purchase_units?: Array<{
    payments?: {
      captures?: Array<{
        id?: string;
        seller_receivable_breakdown?: { gross_amount?: Money; paypal_fee?: Money; net_amount?: Money };
      }>;
    };
  }>;
} | null): Recomputed {
  const capture = order?.purchase_units?.[0]?.payments?.captures?.[0];
  const captureId = dispute.disputed_transactions?.[0]?.seller_transaction_id || capture?.id || null;
  const stake = read(dispute.dispute_amount);
  const allowed = read(dispute.refund_details?.allowed_refund_amount) || stake;
  const gross = read(capture?.seller_receivable_breakdown?.gross_amount) || read(dispute.disputed_transactions?.[0]?.gross_amount);
  const fee = read(capture?.seller_receivable_breakdown?.paypal_fee);
  const net = read(capture?.seller_receivable_breakdown?.net_amount);
  const hold = read((dispute.fund_movements || []).find((row) => row.type === "DEBIT" && row.reason === "HOLD_PLACED")?.amount);
  return {
    stake: stake ? money(stake.cents) : null,
    allowedRefund: allowed ? money(allowed.cents) : null,
    gross: gross ? money(gross.cents) : null,
    fee: fee ? money(fee.cents) : null,
    net: net ? money(net.cents) : null,
    hold: hold ? money(hold.cents) : null,
    deadline: dispute.seller_response_due_date || null,
    currency: stake?.currency || "USD",
    disputeId: dispute.dispute_id,
    captureId,
  };
}
