import { itemSwapWarning } from "./item-intent";
import { decodeJws, sha256B64url, signJws, verifyJws } from "./jws";
import { publicKeyFromJwk, type DemoKeys } from "./keys";

/**
 * AP2-shaped mandates (Agent Payments Protocol v0.2 claim names) for a Human Not Present purchase:
 * the buyer signs open checkout and payment mandates that bind an agent key (`cnf`), the agent signs
 * closed mandates for one checkout, and the merchant signs the checkout and the receipts.
 * Differences from AP2: plain compact JWS instead of SD-JWT, no selective disclosure, demo keys.
 */

export type Ap2Merchant = { id: string; name: string };
export type Ap2Amount = { amount: number; currency: string };
export type Ap2Item = { id: string; title: string };

type CheckoutConstraint =
  | { type: "checkout.allowed_merchants"; allowed: Ap2Merchant[] }
  | { type: "checkout.line_items"; items: Array<{ id: string; acceptable_items: Ap2Item[]; quantity: number }> };
type PaymentConstraint =
  | { type: "payment.amount_range"; currency: string; max: number; min?: number }
  | { type: "payment.allowed_payees"; allowed: Ap2Merchant[] }
  | { type: "payment.reference"; conditional_transaction_id: string };

export type OpenCheckoutMandate = {
  vct: "mandate.checkout.open.1";
  iss: string;
  sub: string;
  iat: number;
  exp: number;
  constraints: CheckoutConstraint[];
  cnf: { jwk: object };
  mendcash_instruction: string;
};
export type OpenPaymentMandate = {
  vct: "mandate.payment.open.1";
  iss: string;
  sub: string;
  iat: number;
  exp: number;
  constraints: PaymentConstraint[];
  cnf: { jwk: object };
};
export type CheckoutPayload = {
  iss: string;
  iat: number;
  id: string;
  merchant: Ap2Merchant;
  line_items: Array<{ id: string; title: string; quantity: number; unit_amount: Ap2Amount }>;
  total: Ap2Amount;
};
export type ClosedCheckoutMandate = { vct: "mandate.checkout.1"; checkout_jwt: string; checkout_hash: string; iat: number; exp: number };
export type ClosedPaymentMandate = {
  vct: "mandate.payment.1";
  transaction_id: string;
  payee: Ap2Merchant;
  payment_amount: Ap2Amount;
  payment_instrument: { type: string; description: string };
  iat: number;
};
export type Ap2Receipt = {
  status: "Success";
  iss: string;
  iat: number;
  reference: string;
  order_id?: string;
  payment_id?: string;
  psp_confirmation_id?: string;
};

export type MandateBundle = {
  version: 1;
  transactionId: string;
  openCheckout: string;
  openPayment: string;
  checkoutJwt: string;
  closedCheckout: string;
  closedPayment: string;
  checkoutReceipt: string | null;
  paymentReceipt: string | null;
  paypal: { orderId: string; captureId: string; customId: string; createdAt: string } | null;
  instruction: string;
  steps: Array<{ at: string; step: string; detail: string }>;
  createdAt: string;
  origin: "replay-fixture" | "replay" | "live";
};

export type MandateGrant = {
  subject: string;
  instruction: string;
  merchant: Ap2Merchant;
  items: Ap2Item[];
  quantity: number;
  maxCents: number;
  currency: string;
  iat: number;
  exp: number;
};

export const CUSTOM_ID_PREFIX = "ap2:";

export function customIdFor(transactionId: string): string {
  return `${CUSTOM_ID_PREFIX}${transactionId}`;
}

export function transactionIdFromCustomId(customId: string | null | undefined): string | null {
  if (!customId || !customId.startsWith(CUSTOM_ID_PREFIX)) return null;
  const id = customId.slice(CUSTOM_ID_PREFIX.length);
  return /^[A-Za-z0-9_-]{43}$/.test(id) ? id : null;
}

/** The buyer's trusted surface signs both open mandates with the user key and binds the agent key (cnf). */
export function grantMandates(keys: DemoKeys, grant: MandateGrant): { openCheckout: string; openPayment: string } {
  const cnf = { jwk: keys.agent.publicJwk };
  const checkout: OpenCheckoutMandate = {
    vct: "mandate.checkout.open.1",
    iss: keys.user.kid,
    sub: grant.subject,
    iat: grant.iat,
    exp: grant.exp,
    constraints: [
      { type: "checkout.allowed_merchants", allowed: [grant.merchant] },
      { type: "checkout.line_items", items: [{ id: "req-1", acceptable_items: grant.items, quantity: grant.quantity }] },
    ],
    cnf,
    mendcash_instruction: grant.instruction,
  };
  const openCheckout = signJws(checkout, keys.user.privateKey, keys.user.kid);
  const payment: OpenPaymentMandate = {
    vct: "mandate.payment.open.1",
    iss: keys.user.kid,
    sub: grant.subject,
    iat: grant.iat,
    exp: grant.exp,
    constraints: [
      { type: "payment.amount_range", currency: grant.currency, max: grant.maxCents, min: 0 },
      { type: "payment.allowed_payees", allowed: [grant.merchant] },
      { type: "payment.reference", conditional_transaction_id: sha256B64url(openCheckout) },
    ],
    cnf,
  };
  return { openCheckout, openPayment: signJws(payment, keys.user.privateKey, keys.user.kid) };
}

export function signCheckout(
  keys: DemoKeys,
  input: { id: string; merchant: Ap2Merchant; item: Ap2Item; unitCents: number; quantity: number; currency: string; iat: number },
): string {
  const payload: CheckoutPayload = {
    iss: keys.merchant.kid,
    iat: input.iat,
    id: input.id,
    merchant: input.merchant,
    line_items: [{ ...input.item, quantity: input.quantity, unit_amount: { amount: input.unitCents, currency: input.currency } }],
    total: { amount: input.unitCents * input.quantity, currency: input.currency },
  };
  return signJws(payload, keys.merchant.privateKey, keys.merchant.kid);
}

/** The agent signs closed mandates for one checkout. transaction_id is AP2's checkout hash. */
export function closeMandates(
  keys: DemoKeys,
  input: { checkoutJwt: string; payee: Ap2Merchant; instrument: string; iat: number; exp: number },
): { closedCheckout: string; closedPayment: string; transactionId: string } {
  const transactionId = sha256B64url(input.checkoutJwt);
  const checkout = decodeJws<CheckoutPayload>(input.checkoutJwt).payload;
  const closed: ClosedCheckoutMandate = { vct: "mandate.checkout.1", checkout_jwt: input.checkoutJwt, checkout_hash: transactionId, iat: input.iat, exp: input.exp };
  const payment: ClosedPaymentMandate = {
    vct: "mandate.payment.1",
    transaction_id: transactionId,
    payee: input.payee,
    payment_amount: checkout.total,
    payment_instrument: { type: "card", description: input.instrument },
    iat: input.iat,
  };
  return {
    closedCheckout: signJws(closed, keys.agent.privateKey, keys.agent.kid),
    closedPayment: signJws(payment, keys.agent.privateKey, keys.agent.kid),
    transactionId,
  };
}

/** Merchant-issued receipts that bind the closed mandates to PayPal's order and capture ids. */
export function issueReceipts(
  keys: DemoKeys,
  input: { closedCheckout: string; closedPayment: string; orderId: string; captureId: string; iat: number },
): { checkoutReceipt: string; paymentReceipt: string } {
  const sign = (payload: Ap2Receipt) => signJws(payload, keys.merchant.privateKey, keys.merchant.kid);
  return {
    checkoutReceipt: sign({ status: "Success", iss: keys.merchant.kid, iat: input.iat, reference: sha256B64url(input.closedCheckout), order_id: input.orderId }),
    paymentReceipt: sign({
      status: "Success",
      iss: keys.merchant.kid,
      iat: input.iat,
      reference: sha256B64url(input.closedPayment),
      payment_id: input.orderId,
      psp_confirmation_id: input.captureId,
    }),
  };
}

export type ConstraintCheck = { id: string; label: string; pass: boolean; detail: string };

function money(cents: number, currency: string): string {
  return `${(cents / 100).toFixed(2)} ${currency}`;
}

/** Open mandates against one checkout. The agent must pass this before it may buy; MendCash reruns it at dispute time. */
export function evaluateConstraints(
  openCheckout: OpenCheckoutMandate,
  openPayment: OpenPaymentMandate,
  checkout: CheckoutPayload,
  atSeconds: number,
): ConstraintCheck[] {
  const merchants = openCheckout.constraints.find((c) => c.type === "checkout.allowed_merchants");
  const payees = openPayment.constraints.find((c) => c.type === "payment.allowed_payees");
  const merchantOk =
    (!merchants || (merchants.type === "checkout.allowed_merchants" && merchants.allowed.some((m) => m.id === checkout.merchant.id))) &&
    (!payees || (payees.type === "payment.allowed_payees" && payees.allowed.some((m) => m.id === checkout.merchant.id)));
  const lines = openCheckout.constraints.find((c) => c.type === "checkout.line_items");
  const requirement = lines && lines.type === "checkout.line_items" ? lines.items[0] : undefined;
  const line = checkout.line_items[0];
  const itemOk = Boolean(requirement && line && requirement.acceptable_items.some((item) => item.id === line.id));
  const qtyOk = Boolean(requirement && line && line.quantity === requirement.quantity && checkout.line_items.length === 1);
  const range = openPayment.constraints.find((c) => c.type === "payment.amount_range");
  const amountOk = Boolean(
    range && range.type === "payment.amount_range" && range.currency === checkout.total.currency &&
      checkout.total.amount <= range.max && checkout.total.amount >= (range.min || 0),
  );
  const timeOk = Number.isFinite(atSeconds) &&
    atSeconds >= Math.max(openCheckout.iat, openPayment.iat) && atSeconds <= Math.min(openCheckout.exp, openPayment.exp);
  return [
    { id: "allowed_merchant", label: "Merchant is one the buyer allowed", pass: merchantOk, detail: `${checkout.merchant.name} (${checkout.merchant.id})` },
    {
      id: "allowed_item",
      label: "Item and quantity are what the buyer allowed",
      pass: itemOk && qtyOk,
      detail: line
        ? `${line.title} x${line.quantity}; allowed: ${requirement?.acceptable_items.map((item) => item.title).join(", ") || "none"} x${requirement?.quantity ?? 0}`
        : "No line item",
    },
    {
      id: "amount_range",
      label: "Total is within the buyer's spending limit",
      pass: amountOk,
      detail: range && range.type === "payment.amount_range"
        ? `${money(checkout.total.amount, checkout.total.currency)} against a limit of ${money(range.max, range.currency)}`
        : "No amount limit in the mandate",
    },
    {
      id: "valid_window",
      label: "Purchase happened while the mandate was valid",
      pass: timeOk,
      detail: Number.isFinite(atSeconds)
        ? `${new Date(atSeconds * 1000).toISOString()} in ${new Date(openCheckout.iat * 1000).toISOString()} to ${new Date(openCheckout.exp * 1000).toISOString()}`
        : "No order time on the PayPal record",
    },
  ];
}

export type PayPalRecord = {
  orderId: string | null;
  captureId: string | null;
  customId: string | null;
  orderCreateTime: string | null;
  captureCents: number | null;
  currency: string | null;
};

export type ProofVerdict = "authorized" | "outside_mandate" | "integrity_failure" | "no_mandate";

export type ProofCheck = ConstraintCheck & { group: "integrity" | "constraint"; source: "PayPal record" | "Signed mandate" | "Recomputed" };

export type ProofSummary = {
  instruction: string;
  merchant: string;
  acceptableItems: string[];
  quantity: number;
  limit: string;
  validFrom: string;
  validUntil: string;
  bought: string;
  total: string;
  userKid: string;
  agentKid: string;
  merchantKid: string;
};

export type AgentProof = {
  itemSwapWarning?: string | null;
  verdict: ProofVerdict;
  label: string;
  transactionId: string | null;
  customId: string | null;
  checks: ProofCheck[];
  summary: ProofSummary | null;
  demoKeys: boolean;
};

export const VERDICT_LABEL: Record<ProofVerdict, string> = {
  authorized: "Authorized under the buyer's signed mandate",
  outside_mandate: "Outside the buyer's mandate",
  integrity_failure: "Mandate records do not match",
  no_mandate: "No agent mandate on this order",
};

function signed(jws: string, key: Parameters<typeof verifyJws>[1] | null): boolean {
  return key !== null && verifyJws(jws, key);
}

/**
 * AP2 v0.2 "Verification: Dispute", adapted: recompute the checkout hash, check every signature,
 * match receipt references, then re-evaluate the open-mandate constraints against PayPal's own
 * record (order time, capture amount, custom_id). Facts come from PayPal wherever PayPal has them.
 */
export function verifyBundle(bundle: MandateBundle | null, keys: DemoKeys, record: PayPalRecord): AgentProof {
  const customTxn = transactionIdFromCustomId(record.customId);
  const empty = (verdict: ProofVerdict, detail: string): AgentProof => ({
    verdict,
    label: VERDICT_LABEL[verdict],
    itemSwapWarning: null,
    transactionId: customTxn,
    customId: record.customId,
    checks: [{ id: "paypal_binding", label: "PayPal order carries a mandate fingerprint", pass: false, detail, group: "integrity", source: "PayPal record" }],
    summary: null,
    demoKeys: keys.seedIsPublic,
  });
  if (!customTxn) return empty("no_mandate", record.customId ? `custom_id ${record.customId} is not an AP2 reference` : "The PayPal order has no custom_id");
  if (!bundle) return empty("integrity_failure", `custom_id references ${customTxn}, but no mandate with that transaction_id is on file`);

  let oc: OpenCheckoutMandate, op: OpenPaymentMandate, chk: CheckoutPayload, cc: ClosedCheckoutMandate, cp: ClosedPaymentMandate;
  try {
    oc = decodeJws<OpenCheckoutMandate>(bundle.openCheckout).payload;
    op = decodeJws<OpenPaymentMandate>(bundle.openPayment).payload;
    chk = decodeJws<CheckoutPayload>(bundle.checkoutJwt).payload;
    cc = decodeJws<ClosedCheckoutMandate>(bundle.closedCheckout).payload;
    cp = decodeJws<ClosedPaymentMandate>(bundle.closedPayment).payload;
  } catch {
    return empty("integrity_failure", "A stored mandate is not a valid compact JWS");
  }
  const checks: ProofCheck[] = [];
  const add = (group: ProofCheck["group"], source: ProofCheck["source"], check: ConstraintCheck) => checks.push({ ...check, group, source });
  const checkoutHash = sha256B64url(bundle.checkoutJwt);

  add("integrity", "PayPal record", {
    id: "paypal_binding",
    label: "PayPal order carries this mandate's fingerprint",
    pass: customTxn === bundle.transactionId && checkoutHash === customTxn,
    detail: `custom_id ${record.customId} on order ${record.orderId || "unknown"}`,
  });
  add("integrity", "Recomputed", {
    id: "checkout_hash",
    label: "Checkout hash recomputes",
    pass: cc.checkout_hash === checkoutHash && cc.checkout_jwt === bundle.checkoutJwt && cp.transaction_id === checkoutHash,
    detail: `SHA-256(checkout_jwt) = ${checkoutHash}`,
  });
  add("integrity", "Signed mandate", {
    id: "user_signature",
    label: "Buyer signed both open mandates",
    pass: signed(bundle.openCheckout, keys.user.publicKey) && signed(bundle.openPayment, keys.user.publicKey),
    detail: `Ed25519, key ${keys.user.kid}${keys.seedIsPublic ? " (public demo key)" : ""}`,
  });
  const agentKey = publicKeyFromJwk(oc.cnf?.jwk);
  add("integrity", "Signed mandate", {
    id: "agent_signature",
    label: "The agent the buyer named signed the purchase",
    pass: JSON.stringify(oc.cnf?.jwk) === JSON.stringify(op.cnf?.jwk) && signed(bundle.closedCheckout, agentKey) && signed(bundle.closedPayment, agentKey),
    detail: `cnf key in the open mandates verifies both closed mandates (${decodeJws(bundle.closedCheckout).header.kid})`,
  });
  add("integrity", "Signed mandate", {
    id: "merchant_signature",
    label: "Merchant signed the checkout",
    pass: signed(bundle.checkoutJwt, keys.merchant.publicKey),
    detail: `checkout ${chk.id}, key ${keys.merchant.kid}`,
  });
  const reference = op.constraints.find((c) => c.type === "payment.reference");
  add("integrity", "Recomputed", {
    id: "payment_link",
    label: "Payment mandate is tied to this checkout mandate",
    pass: reference?.type === "payment.reference" && reference.conditional_transaction_id === sha256B64url(bundle.openCheckout),
    detail: "payment.reference.conditional_transaction_id = SHA-256(open checkout mandate)",
  });
  let receiptsOk = false;
  let receiptDetail = "No receipts on file";
  if (bundle.checkoutReceipt && bundle.paymentReceipt) {
    const cr = decodeJws<Ap2Receipt>(bundle.checkoutReceipt).payload;
    const pr = decodeJws<Ap2Receipt>(bundle.paymentReceipt).payload;
    receiptsOk =
      signed(bundle.checkoutReceipt, keys.merchant.publicKey) && signed(bundle.paymentReceipt, keys.merchant.publicKey) &&
      cr.reference === sha256B64url(bundle.closedCheckout) && pr.reference === sha256B64url(bundle.closedPayment) &&
      cr.order_id === record.orderId && pr.psp_confirmation_id === record.captureId;
    receiptDetail = `receipts name order ${cr.order_id || "?"} and capture ${pr.psp_confirmation_id || "?"}; PayPal has ${record.orderId || "?"} and ${record.captureId || "?"}`;
  }
  add("integrity", "PayPal record", { id: "receipts", label: "Receipts point at this PayPal order and capture", pass: receiptsOk, detail: receiptDetail });
  add("integrity", "PayPal record", {
    id: "paypal_amount",
    label: "PayPal captured exactly the mandated amount",
    pass: record.captureCents === cp.payment_amount.amount && record.currency === cp.payment_amount.currency && cp.payment_amount.amount === chk.total.amount,
    detail: `PayPal capture ${record.captureCents === null ? "unknown" : money(record.captureCents, record.currency || "USD")}; mandate ${money(cp.payment_amount.amount, cp.payment_amount.currency)}`,
  });
  const orderSeconds = record.orderCreateTime ? Math.floor(Date.parse(record.orderCreateTime) / 1000) : Number.NaN;
  for (const check of evaluateConstraints(oc, op, chk, orderSeconds)) {
    add("constraint", check.id === "valid_window" ? "PayPal record" : "Signed mandate", check);
  }

  const integrityOk = checks.filter((c) => c.group === "integrity").every((c) => c.pass);
  const constraintsOk = checks.filter((c) => c.group === "constraint").every((c) => c.pass);
  const verdict: ProofVerdict = !integrityOk ? "integrity_failure" : constraintsOk ? "authorized" : "outside_mandate";
  const lines = oc.constraints.find((c) => c.type === "checkout.line_items");
  const range = op.constraints.find((c) => c.type === "payment.amount_range");
  const line = chk.line_items[0];
  return {
    verdict,
    label: VERDICT_LABEL[verdict],
    itemSwapWarning: line ? itemSwapWarning(oc.mendcash_instruction || "", line.id) : null,
    transactionId: bundle.transactionId,
    customId: record.customId,
    checks,
    summary: {
      instruction: oc.mendcash_instruction || bundle.instruction,
      merchant: chk.merchant.name,
      acceptableItems: lines?.type === "checkout.line_items" ? lines.items[0].acceptable_items.map((item) => item.title) : [],
      quantity: lines?.type === "checkout.line_items" ? lines.items[0].quantity : 0,
      limit: range?.type === "payment.amount_range" ? money(range.max, range.currency) : "none",
      validFrom: new Date(oc.iat * 1000).toISOString(),
      validUntil: new Date(oc.exp * 1000).toISOString(),
      bought: line ? `${line.title} x${line.quantity}` : "nothing",
      total: money(chk.total.amount, chk.total.currency),
      userKid: decodeJws(bundle.openCheckout).header.kid,
      agentKid: decodeJws(bundle.closedCheckout).header.kid,
      merchantKid: decodeJws(bundle.checkoutJwt).header.kid,
    },
    demoKeys: keys.seedIsPublic,
  };
}

/** Public view for GET /api/ap2/checkout-mandates/:transactionId. AP2 leaves mandate retrieval out of scope; this is MendCash's. */
export function publicBundle(bundle: MandateBundle): Record<string, unknown> {
  const decode = (jws: string | null) => (jws ? decodeJws<Record<string, unknown>>(jws).payload : null);
  return {
    transaction_id: bundle.transactionId,
    paypal: bundle.paypal,
    origin: bundle.origin,
    compact: {
      open_checkout_mandate: bundle.openCheckout,
      open_payment_mandate: bundle.openPayment,
      checkout_jwt: bundle.checkoutJwt,
      closed_checkout_mandate: bundle.closedCheckout,
      closed_payment_mandate: bundle.closedPayment,
      checkout_receipt: bundle.checkoutReceipt,
      payment_receipt: bundle.paymentReceipt,
    },
    decoded: {
      open_checkout_mandate: decode(bundle.openCheckout),
      open_payment_mandate: decode(bundle.openPayment),
      checkout: decode(bundle.checkoutJwt),
      closed_checkout_mandate: { ...decode(bundle.closedCheckout), checkout_jwt: "(compact.checkout_jwt)" },
      closed_payment_mandate: decode(bundle.closedPayment),
      checkout_receipt: decode(bundle.checkoutReceipt),
      payment_receipt: decode(bundle.paymentReceipt),
    },
    steps: bundle.steps,
  };
}
