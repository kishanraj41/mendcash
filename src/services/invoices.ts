import { centsToMoney, moneyToCents } from "../money/format";
import { requestIdFor, type PreparedAction } from "../approval/payload";

export type Invoice = {
  id: string;
  number: string;
  status: string;
  currency: string;
  amount: string;
  dueDate: string;
  issuedDate: string;
  recipient: string;
  item: string;
};

export function overdueDays(dueDate: string, now: Date): number {
  const [y, m, d] = dueDate.split("-").map(Number);
  const due = Date.UTC(y, m - 1, d);
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.round((today - due) / 86_400_000);
}

export function percentOf(amount: string, percent: number): string {
  const cents = Math.round((moneyToCents(amount) * percent) / 100);
  return centsToMoney(cents);
}

function plusDays(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

export type InvoicePreview = {
  invoice: Invoice;
  overdueDays: number;
  discountPercent: string;
  discountAmount: string;
  reminder: PreparedAction;
  discountRule: PreparedAction;
};

export function previewInvoice(invoice: Invoice, now: Date): InvoicePreview {
  const late = overdueDays(invoice.dueDate, now);
  const discountAmount = percentOf(invoice.amount, 5);
  const subject = `Invoice ${invoice.number} reminder`;
  const note = [
    `Invoice ${invoice.number} (${invoice.id}) for ${invoice.amount} ${invoice.currency} was due ${invoice.dueDate}.`,
    late > 0 ? `It is ${late} days overdue.` : "It is not overdue yet.",
    `A 5% early-payment discount is ${discountAmount} ${invoice.currency}, computed from the invoice amount.`,
    "Pay within 7 days of the issue date to use it.",
  ].join(" ");
  const reminderBody = {
    invoice_id: invoice.id,
    subject,
    note,
    additional_recipients: [] as string[],
  };
  const ruleBody = {
    invoice_id: invoice.id,
    rules: [
      {
        conditional_rule_type: "EARLY_PAYMENT_DISCOUNT",
        conditional_rule_value_type: "PERCENT",
        conditional_rule_value: "5",
        rule_expiry_terms: {
          rule_expiry_condition: "SEVEN_DAYS_AFTER_ISSUE_DATE",
          condition_rule_end_date: plusDays(invoice.issuedDate, 7),
        },
      },
    ],
  };
  return {
    invoice,
    overdueDays: late,
    discountPercent: "5",
    discountAmount,
    reminder: {
      action: "send_invoice_reminder",
      method: "POST",
      path: `/v2/invoicing/invoices/${invoice.id}/remind`,
      contentType: "application/json",
      requestId: requestIdFor(invoice.id, "send_invoice_reminder", reminderBody),
      body: reminderBody,
      summary: "Send reminder",
    },
    discountRule: {
      action: "create_early_payment_discount",
      method: "POST",
      path: `/v2/invoicing/invoices/${invoice.id}/conditional-rules`,
      contentType: "application/json",
      requestId: requestIdFor(invoice.id, "create_early_payment_discount", ruleBody),
      body: ruleBody,
      summary: `Early-payment discount 5% (${discountAmount} ${invoice.currency})`,
    },
  };
}

export function normalizeInvoice(raw: unknown): Invoice | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  const id = stringField(row.id) || stringField(row.invoice_id);
  const detail = (row.detail && typeof row.detail === "object" ? row.detail : row) as Record<string, unknown>;
  const amountObj = (detail.amount as Record<string, unknown> | undefined) || undefined;
  const amount =
    (amountObj && stringField(amountObj.value)) ||
    stringField(detail.amount_value) ||
    stringField(row.amount);
  if (!id || !amount) return null;
  const due =
    stringField((detail.payment_term as Record<string, unknown> | undefined)?.due_date) ||
    stringField(detail.due_date) ||
    stringField(detail.dueDate);
  if (!due) return null;
  return {
    id,
    number: stringField(detail.invoice_number) || stringField(row.number) || id,
    status: stringField(row.status) || "SENT",
    currency: (amountObj && stringField(amountObj.currency_code)) || stringField(detail.currency) || "USD",
    amount,
    dueDate: due.slice(0, 10),
    issuedDate: (stringField(detail.invoice_date) || stringField(detail.issuedDate) || due).slice(0, 10),
    recipient: stringField(row.recipient) || "buyer@example.com",
    item: stringField(detail.item) || "Invoice",
  };
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value : "";
}
