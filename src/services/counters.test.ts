import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfig } from "../config";
import { Desk } from "./desk";

const NOW = () => new Date("2026-10-31T18:00:00.000Z");

function replayConfig() {
  return loadConfig({ MENDCASH_MODE: "replay", PAYPAL_BASE_URL: "https://api-m.sandbox.paypal.com", INVOICING_ENABLED: "false", PORT: "0" });
}

type Row = Record<string, unknown> & { dispute_id: string; status: string };
type Internals = { disputes: Map<string, Row>; createdIds: Set<string>; syncMoney: (d: Row) => void };

function inject(desk: Desk, row: Row): void {
  const inner = desk as unknown as Internals;
  inner.disputes.set(row.dispute_id, row);
  inner.createdIds.add(row.dispute_id);
  inner.syncMoney(row);
}

function chargeback(id: string, extra: Partial<Row>): Row {
  return {
    dispute_id: id,
    reason: "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED",
    status: "UNDER_REVIEW",
    dispute_life_cycle_stage: "CHARGEBACK",
    create_time: "2026-10-31T17:00:00.000Z",
    update_time: "2026-10-31T17:30:00.000Z",
    dispute_amount: { currency_code: "USD", value: "18.00" },
    evidences: [{ evidence_type: "CREATE", source: "SUBMITTED_BY_BUYER", date: "2026-10-31T17:00:00.000Z", notes: "Not as pictured.", dispute_life_cycle_stage: "CHARGEBACK" }],
    messages: [],
    links: [],
    ...extra,
  };
}

const sellerEvidence = { evidence_type: "OTHER", source: "SUBMITTED_BY_SELLER", date: "2026-10-31T17:20:00.000Z", notes: "Proof.", dispute_life_cycle_stage: "CHARGEBACK" };
const sellerAccept = { ...sellerEvidence, notes: "Full claim accepted.", action_info: { action: "ACCEPT_CLAIM", response_option: "REFUND" } };

describe("counters", () => {
  it("counts an accepted claim as Refunded, never as Submitted", () => {
    const desk = new Desk(replayConfig(), NOW);
    const before = { submitted: Number(desk.submittedUsd()), refunded: Number(desk.refundedUsd()) };
    const contested = chargeback("PP-T-CONTEST", { evidences: [chargeback("x", {}).evidences, sellerEvidence].flat() });
    const folded = chargeback("PP-T-FOLD", { evidences: [chargeback("x", {}).evidences, sellerAccept].flat() });
    inject(desk, contested);
    inject(desk, folded);
    assert.equal((Number(desk.submittedUsd()) - before.submitted).toFixed(2), "18.00", "only the contested dispute is Submitted");
    assert.equal((Number(desk.refundedUsd()) - before.refunded).toFixed(2), "18.00");
  });

  it("shows PayPal reviewing a sandbox decision, then moves Recovered when PayPal resolves it for the seller", async () => {
    const desk = new Desk(replayConfig(), NOW);
    const recoveredBefore = Number(desk.recoveredUsd());
    const row = chargeback("PP-T-REVIEW", {
      evidences: [chargeback("x", {}).evidences, sellerEvidence].flat(),
      adjudications: [{ type: "PAYOUT_TO_BUYER", adjudication_time: "2026-10-31T17:40:00.000Z", reason: "REPRESENTED_BY_PAYPAL" }],
    });
    inject(desk, row);
    const reviewing = (await desk.getCase(row.dispute_id, "10.3.3.3", false)) as { review: { since: string } | null; recommendation: { decision: string; headline: string } };
    assert.equal(reviewing.review?.since, "2026-10-31T17:40:00.000Z");
    assert.equal(reviewing.recommendation.decision, "wait");
    assert.match(reviewing.recommendation.headline, /reviewing it/);
    assert.equal(Number(desk.recoveredUsd()), recoveredBefore, "no win claimed while PayPal reviews");

    row.status = "RESOLVED";
    row.dispute_outcome = { outcome_code: "RESOLVED_SELLER_FAVOUR" };
    (desk as unknown as Internals).syncMoney(row);
    const resolved = (await desk.getCase(row.dispute_id, "10.3.3.3", false)) as { review: unknown };
    assert.equal(resolved.review, null);
    assert.equal((Number(desk.recoveredUsd()) - recoveredBefore).toFixed(2), "18.00");
  });

  it("drops a dispute from Open stake as soon as an approved write returns", async () => {
    const desk = new Desk(replayConfig(), NOW);
    const rows = await desk.listDisputes();
    let checked = false;
    for (const row of rows) {
      if (row.status !== "WAITING_FOR_SELLER_RESPONSE") continue;
      const id = String(row.disputeId);
      const before = Number(await desk.atStakeUsd());
      const preview = await desk.preview(id, "provide_evidence", {});
      if (!preview.payload) continue;
      const done = (await desk.approve(id, "provide_evidence", {})) as { atStakeUsd: string; submittedUsd: string };
      assert.ok(Number(done.atStakeUsd) < before, "Open stake falls in the approval response itself");
      assert.equal(done.atStakeUsd, await desk.atStakeUsd());
      checked = true;
      break;
    }
    assert.ok(checked, "a replay dispute accepted evidence");
  });
});
