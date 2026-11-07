import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfig } from "../config";
import { Desk } from "../services/desk";
import { CATALOG } from "../scenario/catalog";
import { OVERREACH, WITHIN_MANDATE } from "./presets";
const NOW = () => new Date("2026-10-31T18:00:00.000Z");
describe("shared mandate presets", () => {
  it("allows Logo pack $60 and Sticker sheet $18 under the same $75 limit", () => {
    assert.deepEqual(OVERREACH.allowed, WITHIN_MANDATE.allowed);
    assert.equal(OVERREACH.maxUsd, "75"); assert.equal(WITHIN_MANDATE.maxUsd, "75");
    assert.equal(CATALOG.find(i => i.id === "logo-pack")?.amount, "60.00");
    assert.equal(CATALOG.find(i => i.id === "stickers")?.amount, "18.00");
    assert.equal(CATALOG.find(i => i.id === "brand-kit")?.amount, "120.00");
  });
  for (const mode of ["live", "replay"] as const) it(`${mode}: simulated rogue pick is honest and blocked before any order`, async () => {
    const desk = new Desk(loadConfig({ MENDCASH_MODE: mode, PAYPAL_CLIENT_ID: "id", PAYPAL_CLIENT_SECRET: "secret", NEBIUS_API_KEY: "k" }), NOW);
    let orders = 0; let models = 0;
    const stub = desk as unknown as { liveAgentOrder: () => Promise<never>; agentPick: () => Promise<never> };
    stub.liveAgentOrder = async () => { orders++; throw new Error("must not order"); };
    stub.agentPick = async () => { models++; throw new Error("rogue is not a model call"); };
    const result = await desk.agentPurchase({ instruction: OVERREACH.instruction, allowedIds: OVERREACH.allowed, maxUsd: OVERREACH.maxUsd, rogueTest: true }, "test");
    assert.equal(result.status, "blocked"); assert.equal(result.orderId, null);
    assert.equal(result.pick.source, "simulated"); assert.equal(result.pick.itemId, "brand-kit");
    assert.ok(result.checks.some(c => c.id === "amount_range" && !c.pass));
    assert.ok(result.steps.some(s => s.detail.includes("Rogue agent (simulated) picked Brand kit $120")));
    assert.equal(orders, 0); assert.equal(models, 0);
  });
});
