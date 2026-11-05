import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfig } from "../config";
import { toolkitError, disputeItems } from "./toolkit";
import { verifyWebhookSignature } from "./webhook";
import type { PayPalRest } from "./rest";

describe("PayPal failures", () => {
  it("reads the toolkit's error object instead of treating it as an empty list", () => {
    const failed = { error: { message: "Failed to fetch access token: Client Authentication failed", type: "paypal_error" } };
    assert.equal(toolkitError(failed), "Failed to fetch access token: Client Authentication failed");
    assert.deepEqual(disputeItems(failed), []);
    assert.equal(toolkitError({ items: [{ dispute_id: "PP-1" }] }), null);
    assert.equal(toolkitError(JSON.stringify({ error: "boom" })), "boom");
  });

  it("rejects an unsigned webhook without asking PayPal, and hides PayPal's validation text", async () => {
    const config = loadConfig({ MENDCASH_MODE: "live", PAYPAL_CLIENT_ID: "id", PAYPAL_CLIENT_SECRET: "s", PAYPAL_WEBHOOK_ID: "WH1", NEBIUS_API_KEY: "k", PAYPAL_BASE_URL: "https://api-m.sandbox.paypal.com" });
    let calls = 0;
    const failing = { json: async () => { calls += 1; throw new Error("400 INVALID_REQUEST debug_id=abc"); } } as unknown as PayPalRest;
    assert.equal(await verifyWebhookSignature(failing, config, {}, { id: "WH-TEST" }), false);
    assert.equal(calls, 0, "no PayPal call without transmission headers");
    const headers = {
      "paypal-auth-algo": "SHA256withRSA",
      "paypal-cert-url": "https://api.sandbox.paypal.com/cert",
      "paypal-transmission-id": "t1",
      "paypal-transmission-sig": "sig",
      "paypal-transmission-time": "2026-11-04T00:00:00Z",
    };
    const original = console.error;
    console.error = () => undefined;
    try {
      assert.equal(await verifyWebhookSignature(failing, config, headers, { id: "WH-TEST" }), false);
    } finally {
      console.error = original;
    }
    assert.equal(calls, 1);
  });
});
