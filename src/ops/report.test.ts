import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfig } from "../config";
import { credentialReport, formatCredentialReport } from "../ops/report";
import { smokePlan } from "../../scripts/smoke";

describe("credentials report", () => {
  it("never includes secret values", () => {
    const env = {
      PAYPAL_CLIENT_ID: "id-super-secret",
      PAYPAL_CLIENT_SECRET: "secret-super-secret",
      PAYPAL_WEBHOOK_ID: "",
      NEBIUS_API_KEY: "nebius-super-secret",
    };
    const text = formatCredentialReport(credentialReport(env));
    assert.match(text, /PAYPAL_CLIENT_SECRET: set/);
    assert.match(text, /PAYPAL_WEBHOOK_ID: missing/);
    assert.equal(text.includes("super-secret"), false);
    const plan = smokePlan(credentialReport(env));
    assert.equal(plan.paypal, true);
    assert.equal(plan.nebius, true);
    assert.equal(plan.webhookMissing, true);
  });

  it("refuses the model that followed a planted refund", () => {
    assert.throws(
      () => loadConfig({ AGENT_MODEL: "Qwen/Qwen3-235B-A22B-Instruct-2507", MENDCASH_MODE: "replay" }),
      /banned/,
    );
    assert.throws(() => loadConfig({ ROUTER_MODEL: "Qwen/Qwen3-235B-A22B-Instruct-2507" }), /banned/);
  });
});
