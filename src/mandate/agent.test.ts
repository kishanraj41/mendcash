import assert from "node:assert/strict";
import { it } from "node:test";
import { pickWithModel } from "./agent";
import { CATALOG } from "../scenario/catalog";
import { Desk } from "../services/desk";
import { loadConfig } from "../config";
it("unusable live picks are labeled rules fallback, not replay", async () => {
  const pick = await pickWithModel({instruction: "Get the logo pack", catalog: CATALOG, allowedIds: ["logo-pack", "stickers"], maxUsd: "75", model: "test"}, async () => ({ content: '{"item_id":"not-in-catalog"}', usage: {prompt_tokens: 10, completion_tokens: 5}, latencyMs: 1 }));
  assert.equal(pick.itemId, "logo-pack"); assert.equal(pick.model, "rules-fallback");
  assert.match(pick.reason, /Rules fallback/); assert.doesNotMatch(pick.reason, /replay|rules picked/i);
});
it("live steps label a rules pick as fallback, while replay remains labeled replay", async () => {
  for (const mode of ["live", "replay"] as const) {
    const desk = new Desk(loadConfig({MENDCASH_MODE:mode, PAYPAL_CLIENT_ID:"id", PAYPAL_CLIENT_SECRET:"secret"}));
    // An out-of-mandate pick exercises the label without any real order or model call.
    const result = await desk.agentPurchase({instruction:"Get the brand kit", allowedIds:["stickers"], maxUsd:"75"}, "test");
    assert.equal(result.status, "blocked");
    const step = result.steps.find(s=>s.step === "pick")!.detail;
    assert.match(step, mode === "live" ? /rules fallback/ : /replay rules/);
    if (mode === "live") assert.doesNotMatch(step, /replay|rules picked/);
  }
});
