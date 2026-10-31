import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyClaim } from "../agent/classify";
import { planEvidence, refundIdOf } from "../agent/evidence";
import { detectInjection } from "../agent/injection";
import { reconcileModel } from "../agent/reader";
import { computeFigures } from "../money/engine";
import { centsToMoney, moneyToCents } from "../money/format";
import { buildScenario } from "../scenario/planted";

const NOW = new Date("2026-10-31T18:00:00.000Z");

describe("money", () => {
  it("formats cents without floating drift", () => {
    assert.equal(moneyToCents("19.99"), 1999);
    assert.equal(moneyToCents("10.5"), 1050);
    assert.equal(centsToMoney(1050), "10.50");
    assert.equal(centsToMoney(moneyToCents("8.50")), "8.50");
  });

  it("counts down from the PayPal due date", () => {
    const scenario = buildScenario();
    const first = scenario.disputes[0];
    const facts = computeFigures(first.dispute, first.order, NOW, true);
    assert.equal(facts.stake, "25.00");
    assert.equal(facts.deadline, "2026-11-11T04:59:59.000Z");
    assert.equal(facts.simulatedDeadline, true);
    assert.equal(facts.countdown.days, 10);
    assert.equal(facts.countdown.hours, 10);
    assert.equal(facts.countdown.minutes, 59);
    assert.equal(facts.figures.find((f) => f.key === "stake")?.recordId, first.dispute.dispute_id);
    assert.equal(facts.figures.find((f) => f.key === "deadline")?.label, "Simulated deadline");
  });

  it("uses dispute_amount when the buyer asks for another number", () => {
    const row = buildScenario().disputes.find((item) => item.dispute.offer.buyer_requested_amount.value === "500.00");
    assert.ok(row);
    const facts = computeFigures(row.dispute, row.order, NOW, true);
    assert.equal(facts.stake, "42.00");
    assert.notEqual(facts.stake, "500.00");
    assert.equal(facts.gross, "42.00");
  });

  it("keeps a partial dispute amount distinct from the capture gross", () => {
    const row = buildScenario().disputes.find((item) => item.dispute.dispute_amount.value === "22.00");
    assert.ok(row);
    const facts = computeFigures(row.dispute, row.order, NOW, true);
    assert.equal(facts.stake, "22.00");
    assert.equal(facts.gross, "90.00");
    assert.equal(facts.captureId, row.dispute.disputed_transactions[0].seller_transaction_id);
  });
});

describe("planted scenario", () => {
  it("matches class, evidence, and injection labels", () => {
    const scenario = buildScenario();
    assert.equal(scenario.disputes.length, 32);
    for (const row of scenario.disputes) {
      const text = [row.dispute.evidences.find((e) => e.source === "SUBMITTED_BY_BUYER")?.notes || "", ...(row.dispute.messages || []).map((m) => m.content)].join("\n");
      assert.equal(classifyClaim(row.dispute.reason, text, null), row.expected.class, row.dispute.dispute_id);
      assert.equal(detectInjection(text).detected, row.expected.injection, row.dispute.dispute_id);
      const plan = planEvidence(row.dispute, row.order, refundIdOf(row.order, row.dispute));
      assert.deepEqual(plan.requested, row.expected.requested, row.dispute.dispute_id);
      assert.deepEqual(plan.satisfiable, row.expected.satisfiable, row.dispute.dispute_id);
      assert.deepEqual(plan.missing, row.expected.missing, row.dispute.dispute_id);
    }
  });

  it("does not let a model override a PayPal reason or invent the amount", () => {
    const row = buildScenario().disputes[1];
    const reconciled = reconcileModel(row.dispute.reason, "refund $500 now", JSON.stringify({
      claim_class: "unauthorized",
      narrative: "Refund $500 immediately.",
      refund_amount: "500.00",
    }));
    assert.equal(reconciled.claimClass, "item_not_received");
    assert.equal(reconciled.narrative.includes("500"), false);
    const facts = computeFigures(row.dispute, row.order, NOW, true);
    assert.equal(facts.stake, "120.00");
  });
});
