import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfig } from "../config";
import { encodeMultipart, PayPalRest } from "../paypal/rest";
import { processChargebackBody } from "../paypal/chargeback";
import { verifyWebhookSignature } from "../paypal/webhook";
import type { HttpClient } from "../paypal/http";

function config() {
  return loadConfig({
    MENDCASH_MODE: "live",
    PAYPAL_CLIENT_ID: "client-id-value",
    PAYPAL_CLIENT_SECRET: "client-secret-value",
    PAYPAL_WEBHOOK_ID: "WH-TEST",
    PAYPAL_BASE_URL: "https://api-m.sandbox.paypal.com",
  });
}

describe("paypal rest", () => {
  it("builds a sandbox chargeback body and a multipart evidence body", () => {
    const body = processChargebackBody({
      merchantId: "MERCHANT",
      captureId: "CAP123",
      amount: "25.00",
      reasonCode: "4855",
      notes: "The files never arrived",
      responseDate: "2026-11-11T04:59:59.000Z",
      receiveDate: "2026-10-31T18:00:00.000Z",
      cardBrand: "VISA",
    });
    assert.equal(body.adjacency, "PAYPAL");
    assert.equal((body.dispute as { processor_info: { reason_code: string; notes: string } }).processor_info.reason_code, "4855");
    assert.match((body.dispute as { processor_info: { notes: string } }).processor_info.notes, /never arrived/);
    const form = encodeMultipart(JSON.stringify({ evidences: [{ evidence_type: "OTHER", notes: "hi" }] }));
    assert.match(form.contentType, /multipart\/form-data/);
    assert.match(form.body.toString("utf8"), /name="input"/);
    assert.match(form.body.toString("utf8"), /PROOF|OTHER/);
  });

  it("adds the evidence file as its own binary part after the JSON input", () => {
    const pdf = Buffer.from("%PDF-1.7\nâãbinary\n%%EOF", "latin1");
    const form = encodeMultipart(JSON.stringify({ evidences: [{ evidence_type: "OTHER", documents: [{ name: "proof.pdf" }] }] }), [
      { field: "evidence-file", name: "proof.pdf", contentType: "application/pdf", data: pdf },
    ]);
    const text = form.body.toString("latin1");
    assert.ok(text.indexOf('name="input"') < text.indexOf('name="evidence-file"; filename="proof.pdf"'));
    assert.match(text, /Content-Type: application\/pdf\r\n\r\n%PDF-1\.7/);
    assert.ok(form.body.includes(pdf), "file bytes are copied unchanged");
    assert.match(text, /------mendcashform7--\r\n$/);
  });

  it("verifies webhook signatures through PayPal and does not echo the token", async () => {
    const calls: string[] = [];
    const http: HttpClient = async (req) => {
      calls.push(`${req.method} ${req.url}`);
      assert.equal(JSON.stringify(req.headers).includes("client-secret-value"), false);
      if (req.url.endsWith("/v1/oauth2/token")) {
        return { status: 200, headers: {}, body: JSON.stringify({ access_token: "token-value", expires_in: 300 }) };
      }
      const parsed = JSON.parse(typeof req.body === "string" ? req.body : "{}") as { webhook_id?: string; webhook_event?: { id?: string } };
      assert.equal(parsed.webhook_id, "WH-TEST");
      assert.equal(parsed.webhook_event?.id, "WH-1");
      assert.equal(req.url.includes("?"), false);
      return { status: 200, headers: {}, body: JSON.stringify({ verification_status: "SUCCESS" }) };
    };
    const rest = new PayPalRest({ config: config(), http });
    const ok = await verifyWebhookSignature(
      rest,
      config(),
      {
        "paypal-auth-algo": "SHA256withRSA",
        "paypal-cert-url": "https://api.sandbox.paypal.com/v1/notifications/certs/CERT",
        "paypal-transmission-id": "t",
        "paypal-transmission-sig": "sig",
        "paypal-transmission-time": "2026-11-04T00:00:00Z",
      },
      { id: "WH-1" },
    );
    assert.equal(ok, true);
    assert.equal(calls.some((c) => c.includes("verify-webhook-signature")), true);
    assert.equal(calls.join("\n").includes("token-value"), false);
  });
});
