import { centsToMoney, moneyToCents } from "./format";

export type MoneyValue = { currency_code?: string; value?: string };

export type Figure = {
  key: string;
  label: string;
  value: string | null;
  currency: string | null;
  source: string;
  recordId: string;
  recordType: "dispute" | "capture" | "order" | "tracker";
  simulated?: boolean;
};

export type Countdown = {
  deadline: string | null;
  overdue: boolean;
  days: number;
  hours: number;
  minutes: number;
  simulated: boolean;
  source: string;
  recordId: string;
};

export type DisputeMoneyInput = {
  dispute_id: string;
  dispute_amount?: MoneyValue;
  seller_response_due_date?: string;
  refund_details?: { allowed_refund_amount?: MoneyValue };
  fund_movements?: Array<{ amount?: MoneyValue; type?: string; reason?: string }>;
  disputed_transactions?: Array<{ seller_transaction_id?: string; gross_amount?: MoneyValue }>;
  extensions?: { mendcash_simulated_deadline?: boolean };
};

export type OrderMoneyInput = {
  id?: string;
  purchase_units?: Array<{
    payments?: {
      captures?: Array<{
        id?: string;
        amount?: MoneyValue;
        seller_receivable_breakdown?: {
          gross_amount?: MoneyValue;
          paypal_fee?: MoneyValue;
          net_amount?: MoneyValue;
        };
      }>;
    };
    shipping?: { trackers?: Array<{ id?: string; tracking_number?: string }> };
  }>;
};

export type MoneyFacts = {
  currency: string;
  stake: string | null;
  stakeCents: number | null;
  allowedRefund: string | null;
  gross: string | null;
  fee: string | null;
  net: string | null;
  hold: string | null;
  deadline: string | null;
  simulatedDeadline: boolean;
  disputeId: string;
  captureId: string | null;
  orderId: string | null;
  trackerId: string | null;
  figures: Figure[];
  countdown: Countdown;
};

function readMoney(value: MoneyValue | undefined): { currency: string; cents: number } | null {
  if (!value?.value) return null;
  return {
    currency: value.currency_code || "USD",
    cents: moneyToCents(value.value),
  };
}

export function computeFigures(
  dispute: DisputeMoneyInput,
  order: OrderMoneyInput | null,
  now: Date,
  options: { replay: boolean } = { replay: false },
): MoneyFacts {
  const capture = order?.purchase_units?.[0]?.payments?.captures?.[0];
  const captureId = dispute.disputed_transactions?.[0]?.seller_transaction_id || capture?.id || null;
  const breakdown = capture?.seller_receivable_breakdown;
  const stake = readMoney(dispute.dispute_amount);
  const allowed = readMoney(dispute.refund_details?.allowed_refund_amount) || stake;
  const grossFromBreakdown = readMoney(breakdown?.gross_amount);
  const grossFromTxn = readMoney(dispute.disputed_transactions?.[0]?.gross_amount);
  const gross = grossFromBreakdown || grossFromTxn;
  const grossSource = grossFromBreakdown
    ? "seller_receivable_breakdown.gross_amount"
    : "disputed_transactions.gross_amount";
  const fee = readMoney(breakdown?.paypal_fee);
  const net = readMoney(breakdown?.net_amount);
  const holdMove = (dispute.fund_movements || []).find((m) => m.type === "DEBIT" && m.reason === "HOLD_PLACED");
  const hold = readMoney(holdMove?.amount);
  const tracker = order?.purchase_units?.[0]?.shipping?.trackers?.[0];
  const deadline = dispute.seller_response_due_date || null;
  // A date PayPal returned in seller_response_due_date is PayPal's date, including in the sandbox.
  // Replay fixtures are not live PayPal, so those deadlines stay labeled simulated.
  const simulated = options.replay;
  const currency = stake?.currency || gross?.currency || "USD";
  const disputeId = dispute.dispute_id;

  const figures: Figure[] = [];
  const push = (
    key: string,
    label: string,
    money: { currency: string; cents: number } | null,
    source: string,
    recordId: string,
    recordType: Figure["recordType"],
  ) => {
    figures.push({
      key,
      label,
      value: money ? centsToMoney(money.cents) : null,
      currency: money ? money.currency : null,
      source,
      recordId,
      recordType,
    });
  };

  push("stake", "Amount at stake", stake, "dispute_amount", disputeId, "dispute");
  push("allowed_refund", "Allowed refund", allowed, "refund_details.allowed_refund_amount", disputeId, "dispute");
  if (captureId) {
    push("gross", "Capture gross", gross, grossSource, grossFromBreakdown ? captureId : disputeId, grossFromBreakdown ? "capture" : "dispute");
    push(
      "fee",
      "PayPal fee",
      fee,
      fee ? "seller_receivable_breakdown.paypal_fee" : "seller_receivable_breakdown absent",
      captureId,
      "capture",
    );
    push(
      "net",
      "Seller net",
      net,
      net ? "seller_receivable_breakdown.net_amount" : "seller_receivable_breakdown absent",
      captureId,
      "capture",
    );
  }
  if (hold) push("hold", "Hold placed", hold, "fund_movements.HOLD_PLACED", disputeId, "dispute");

  figures.push({
    key: "deadline",
    label: simulated ? "Simulated deadline" : "Response deadline",
    value: deadline,
    currency: null,
    source: "seller_response_due_date",
    recordId: disputeId,
    recordType: "dispute",
    simulated,
  });

  let countdown: Countdown = {
    deadline,
    overdue: false,
    days: 0,
    hours: 0,
    minutes: 0,
    simulated,
    source: "seller_response_due_date",
    recordId: disputeId,
  };
  if (deadline) {
    const ms = Date.parse(deadline) - now.getTime();
    const overdue = ms < 0;
    const abs = Math.abs(ms);
    countdown = {
      ...countdown,
      overdue,
      days: Math.floor(abs / 86_400_000),
      hours: Math.floor((abs % 86_400_000) / 3_600_000),
      minutes: Math.floor((abs % 3_600_000) / 60_000),
    };
  }

  return {
    currency,
    stake: stake ? centsToMoney(stake.cents) : null,
    stakeCents: stake ? stake.cents : null,
    allowedRefund: allowed ? centsToMoney(allowed.cents) : null,
    gross: gross ? centsToMoney(gross.cents) : null,
    fee: fee ? centsToMoney(fee.cents) : null,
    net: net ? centsToMoney(net.cents) : null,
    hold: hold ? centsToMoney(hold.cents) : null,
    deadline,
    simulatedDeadline: simulated,
    disputeId,
    captureId,
    orderId: order?.id || null,
    trackerId: tracker?.id || tracker?.tracking_number || null,
    figures,
    countdown,
  };
}

export function partialRefundCents(
  requested: string,
  facts: MoneyFacts,
  caps: { maxPartialRefundUsd: number },
): { cents: number; value: string } {
  const requestedCents = moneyToCents(requested);
  const stake = facts.stakeCents;
  const allowed = facts.allowedRefund ? moneyToCents(facts.allowedRefund) : stake;
  const cap = moneyToCents(centsToMoney(Math.round(caps.maxPartialRefundUsd * 100)));
  if (stake === null || allowed === null) {
    throw new Error("This dispute has no amount on the PayPal record.");
  }
  if (requestedCents <= 0) throw new Error("A partial refund has to be more than zero.");
  if (requestedCents >= stake) {
    throw new Error("A partial refund has to be less than the dispute amount. Use accept claim for the full amount.");
  }
  if (requestedCents > allowed) {
    throw new Error(`That is above the allowed refund of ${facts.allowedRefund} ${facts.currency} on ${facts.disputeId}.`);
  }
  if (requestedCents > cap) {
    throw new Error(`That is above the partial-refund cap of ${centsToMoney(cap)} USD.`);
  }
  return { cents: requestedCents, value: centsToMoney(requestedCents) };
}
