import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import type { AgentProof, MandateBundle } from "./ap2";

export type EvidencePdfInput = {
  disputeId: string;
  reason: string;
  stake: string;
  currency: string;
  proof: AgentProof;
  paypal: { orderId: string | null; captureId: string | null; customId: string | null; orderCreateTime: string | null };
  bundle: MandateBundle | null;
  generatedAt: string;
};

export const EVIDENCE_PDF_NAME = "mendcash-agent-mandate.pdf";

/** WinAnsi-safe text for the standard fonts. */
function ascii(text: string): string {
  return text.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, "-").replace(/[^\x20-\x7E]/g, "?");
}

class Writer {
  page: PDFPage;
  y: number;
  constructor(private readonly doc: PDFDocument, private readonly margin = 48) {
    this.page = doc.addPage([612, 792]);
    this.y = 792 - margin;
  }
  private ensure(height: number) {
    if (this.y - height < this.margin) {
      this.page = this.doc.addPage([612, 792]);
      this.y = 792 - this.margin;
    }
  }
  text(value: string, font: PDFFont, size: number, color = rgb(0.11, 0.1, 0.08), gap = 3) {
    const width = 612 - this.margin * 2;
    const words = ascii(value).split(/(\s+)/);
    let line = "";
    const flush = () => {
      this.ensure(size + gap);
      this.page.drawText(line, { x: this.margin, y: this.y - size, size, font, color });
      this.y -= size + gap;
      line = "";
    };
    for (const word of words) {
      const next = line + word;
      if (font.widthOfTextAtSize(next, size) > width && line.trim()) {
        flush();
        line = word.trimStart();
        while (font.widthOfTextAtSize(line, size) > width) {
          let cut = line.length;
          while (cut > 1 && font.widthOfTextAtSize(line.slice(0, cut), size) > width) cut -= 1;
          const rest = line.slice(cut);
          line = line.slice(0, cut);
          flush();
          line = rest;
        }
      } else {
        line = next;
      }
    }
    if (line.trim()) flush();
  }
  space(points: number) {
    this.y -= points;
  }
}

/** One-page mandate verification for PayPal provide-evidence, plus an appendix with the signed mandates. */
export async function mandateEvidencePdf(input: EvidencePdfInput): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const at = new Date(input.generatedAt);
  doc.setTitle(`Agent purchase mandate for dispute ${input.disputeId}`);
  doc.setAuthor("MendCash");
  doc.setProducer("MendCash");
  doc.setCreator("MendCash");
  doc.setCreationDate(at);
  doc.setModificationDate(at);
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const mono = await doc.embedFont(StandardFonts.Courier);
  const w = new Writer(doc);
  const muted = rgb(0.37, 0.35, 0.31);
  const proof = input.proof;
  const s = proof.summary;

  w.text("Agent purchase: the buyer's signed mandate", bold, 16, rgb(0.11, 0.26, 0.2), 6);
  w.text(`Dispute ${input.disputeId} | ${input.reason.replaceAll("_", " ")} | ${input.stake} ${input.currency} (PayPal dispute_amount)`, regular, 10, muted);
  w.space(6);
  w.text(`Result: ${proof.label}`, bold, 13, proof.verdict === "authorized" ? rgb(0.11, 0.26, 0.2) : rgb(0.55, 0.18, 0.16), 6);
  w.text(
    `PayPal record: order ${input.paypal.orderId || "-"}, capture ${input.paypal.captureId || "-"}, created ${input.paypal.orderCreateTime || "-"}, custom_id ${input.paypal.customId || "-"}.`,
    regular,
    10,
  );
  if (proof.itemSwapWarning) w.text(`Human review required: ${proof.itemSwapWarning}`, bold, 11, rgb(0.55, 0.18, 0.16), 6);
  w.space(6);
  if (s) {
    w.text("What the buyer authorized (open mandates, signed by the buyer)", bold, 11, undefined, 4);
    w.text(`Instruction: "${s.instruction}"`, regular, 10);
    w.text(`Merchant: ${s.merchant}. Items allowed: ${s.acceptableItems.join(", ")} (quantity ${s.quantity}). Spending limit: ${s.limit}.`, regular, 10);
    w.text(`Valid ${s.validFrom} to ${s.validUntil}. Buyer key ${s.userKid}; the agent key is bound by cnf.`, regular, 10);
    w.space(4);
    w.text("What the agent bought (closed mandates, signed by that agent)", bold, 11, undefined, 4);
    w.text(`${s.bought}, total ${s.total}. Agent key ${s.agentKid}. Checkout signed by merchant key ${s.merchantKid}.`, regular, 10);
    w.space(6);
  }
  w.text("Checks (AP2 v0.2 dispute verification, then PayPal's record)", bold, 11, undefined, 4);
  for (const check of proof.checks) {
    w.text(`[${check.pass ? "PASS" : "FAIL"}] ${check.label} - ${check.detail} (${check.source})`, check.pass ? regular : bold, 9.5);
  }
  w.space(6);
  w.text(`transaction_id (SHA-256 of the merchant-signed checkout): ${proof.transactionId || "-"}`, mono, 8, muted);
  w.space(8);
  w.text(
    "How to check this yourself: the PayPal order's custom_id is 'ap2:' plus the transaction_id. Hash the checkout_jwt in the appendix " +
      "with SHA-256 (base64url) and compare. Signatures are Ed25519 (JWS alg EdDSA); public keys are in the cnf claim and at " +
      "GET /api/ap2/checkout-mandates/<transaction_id> on the MendCash deployment." +
      (proof.demoKeys ? " This sandbox demo signs with published demo keys, so signatures here show integrity, not identity." : ""),
    regular,
    8.5,
    muted,
  );
  w.text(`Generated ${input.generatedAt} by MendCash in the PayPal sandbox.`, regular, 8.5, muted);

  if (input.bundle) {
    w.page = doc.addPage([612, 792]);
    w.y = 792 - 48;
    w.text("Appendix: signed mandates (compact JWS)", bold, 12, undefined, 6);
    const rows: Array<[string, string | null]> = [
      ["open_checkout_mandate (buyer)", input.bundle.openCheckout],
      ["open_payment_mandate (buyer)", input.bundle.openPayment],
      ["checkout_jwt (merchant)", input.bundle.checkoutJwt],
      ["closed_checkout_mandate (agent)", input.bundle.closedCheckout],
      ["closed_payment_mandate (agent)", input.bundle.closedPayment],
      ["checkout_receipt (merchant)", input.bundle.checkoutReceipt],
      ["payment_receipt (merchant)", input.bundle.paymentReceipt],
    ];
    for (const [label, value] of rows) {
      w.text(label, bold, 8.5, undefined, 2);
      w.text(value || "-", mono, 6, muted, 1.5);
      w.space(4);
    }
  }
  return doc.save({ useObjectStreams: false });
}
