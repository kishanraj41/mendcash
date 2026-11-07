import assert from "node:assert/strict";
import { it } from "node:test";
import { itemSwapWarning } from "./item-intent";
import { buildAgenticScenario } from "../scenario/agentic";
import { demoKeys } from "./keys";
import { Desk } from "../services/desk";
import { loadConfig } from "../config";
it("matching catalog title or alias produces no warning", () => {
  assert.equal(itemSwapWarning("Get the logo-pack for launch", "logo-pack"), null);
  assert.equal(itemSwapWarning("Buy stickers", "stickers"), null);
  assert.equal(itemSwapWarning("A brand kit or logo pack", "logo-pack"), null);
});
it("a named item swapped for another triggers warning and Your call with 12 checks unchanged", async () => {
  assert.match(itemSwapWarning("Buy the brand kit for launch", "logo-pack")!, /Agent bought Logo pack, but the buyer asked for Brand kit/);
  const config = loadConfig({ MENDCASH_MODE: "replay" });
  const row = buildAgenticScenario(demoKeys(config.mandate.keySeed)).at(-1)!;
  const view = await new Desk(config).getCase(row.expected.disputeId, "test", false) as any;
  assert.equal(view.agentProof.verdict, "authorized");
  assert.equal(view.agentProof.checks.length, 12);
  assert.ok(view.agentProof.checks.every((c: any) => c.pass));
  assert.equal(view.recommendation.decision, "review");
  assert.match(view.recommendation.headline, /Your call/);
});
it("instruction without a catalog name has no warning", () => {
  assert.equal(itemSwapWarning("Get something for the launch", "logo-pack"), null);
  assert.equal(itemSwapWarning("This is a smug remark", "logo-pack"), null);
});
