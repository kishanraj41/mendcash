import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfig } from "../config";
import { Desk } from "../services/desk";
import { CATALOG } from "../scenario/catalog";
import type { AgentPick } from "./agent";
import { OVERREACH, WITHIN_MANDATE } from "./presets";

const NOW = () => new Date("2026-10-31T18:00:00.000Z");
const base = { PAYPAL_BASE_URL: "https://api-m.sandbox.paypal.com", INVOICING_ENABLED: "false", PORT: "0" };

describe("agent presets", () => {
  it("the overreach limit is below every catalog price, so no cart can fit it", () => {
    const cheapest = Math.min(...CATALOG.map((item) => Math.round(Number(item.amount) * 100)));
    assert.ok(Math.round(Number(OVERREACH.maxUsd) * 100) < cheapest);
    assert.ok(Math.round(Number(WITHIN_MANDATE.maxUsd) * 100) >= cheapest, "the in-mandate preset can still buy");
  });

  it("live: the guard blocks the overreach preset for any pick the model could make, and no PayPal order is created", async () => {
    const desk = new Desk(loadConfig({ ...base, MENDCASH_MODE: "live", PAYPAL_CLIENT_ID: "id", PAYPAL_CLIENT_SECRET: "secret", NEBIUS_API_KEY: "k" }), NOW);
    let orders = 0;
    const stub = desk as unknown as { agentPick: () => Promise<AgentPick>; liveAgentOrder: () => Promise<never> };
    stub.liveAgentOrder = async () => {
      orders += 1;
      throw new Error("must not create an order");
    };
    for (const item of CATALOG) {
      for (const quantity of [1, 2, 3]) {
        stub.agentPick = async () => ({ itemId: item.id, quantity, reason: "stub", source: "model", model: "stub-model", usage: { prompt_tokens: 0, completion_tokens: 0 }, latencyMs: 0 });
        const result = await desk.agentPurchase({ instruction: OVERREACH.instruction, allowedIds: OVERREACH.allowed, maxUsd: OVERREACH.maxUsd }, `10.0.0.${quantity}`);
        assert.equal(result.status, "blocked", `${item.id} x${quantity}`);
        assert.equal(result.orderId, null);
        assert.ok(result.checks.some((check) => check.id === "amount_range" && !check.pass), `${item.id} x${quantity} fails the spending limit`);
      }
    }
    assert.equal(orders, 0);
    assert.equal(desk.agentPurchases().length, 0);
  });

  it("replay: the overreach preset is blocked with no order", async () => {
    const desk = new Desk(loadConfig({ ...base, MENDCASH_MODE: "replay" }), NOW);
    for (let i = 0; i < 5; i += 1) {
      const result = await desk.agentPurchase({ instruction: OVERREACH.instruction, allowedIds: OVERREACH.allowed, maxUsd: OVERREACH.maxUsd }, "10.0.0.9");
      assert.equal(result.status, "blocked");
      assert.equal(result.orderId, null);
    }
    assert.equal(desk.agentPurchases().filter((row) => row.origin === "replay").length, 0, "blocked picks store nothing");
  });
});
