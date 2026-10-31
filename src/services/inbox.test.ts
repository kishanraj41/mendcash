import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BUYER_PENDING_DETAIL, BUYER_PENDING_LABEL, buyerTextPending, listStatusTtlMs, newerListStatus, shouldAnalyzeBuyer } from "./inbox";

describe("inbox status", () => {
  it("keeps a newer detail status when the list row is older", () => {
    const kept = newerListStatus(
      { status: "WAITING_FOR_SELLER_RESPONSE", update_time: "2026-10-31T18:10:00.000Z" },
      { status: "UNDER_REVIEW", update_time: "2026-10-31T18:00:00.000Z" },
    );
    assert.equal(kept.status, "WAITING_FOR_SELLER_RESPONSE");
  });

  it("takes a newer list status without dropping the cached record's time on a tie", () => {
    const taken = newerListStatus(
      { status: "UNDER_REVIEW", update_time: "2026-10-31T18:00:00.000Z" },
      { status: "WAITING_FOR_SELLER_RESPONSE", update_time: "2026-10-31T18:12:00.000Z" },
    );
    assert.equal(taken.status, "WAITING_FOR_SELLER_RESPONSE");
    const tie = newerListStatus(
      { status: "WAITING_FOR_SELLER_RESPONSE", update_time: "2026-10-31T18:12:00.000Z" },
      { status: "UNDER_REVIEW", update_time: "2026-10-31T18:12:00.000Z" },
    );
    assert.equal(tie.status, "WAITING_FOR_SELLER_RESPONSE");
  });

  it("refreshes open rows sooner than resolved ones", () => {
    assert.equal(listStatusTtlMs("UNDER_REVIEW"), 15_000);
    assert.equal(listStatusTtlMs("WAITING_FOR_SELLER_RESPONSE"), 15_000);
    assert.equal(listStatusTtlMs("OPEN"), 15_000);
    assert.equal(listStatusTtlMs("RESOLVED"), 60_000);
  });
});

describe("buyer text pending", () => {
  it("does not classify or analyze an open dispute with no buyer text", () => {
    const open = { status: "OPEN", evidences: [], messages: [] };
    assert.equal(buyerTextPending(open), true);
    assert.equal(shouldAnalyzeBuyer(open, "auto", true, false), false);
    assert.equal(shouldAnalyzeBuyer(open, true, true, false), false);
    assert.equal(BUYER_PENDING_LABEL.length > 0, true);
    assert.match(BUYER_PENDING_DETAIL, /Waiting for PayPal/);
  });

  it("analyzes once buyer text exists and the read is not cached", () => {
    const ready = {
      evidences: [{ source: "SUBMITTED_BY_BUYER", notes: "The mug arrived cracked." }],
    };
    assert.equal(buyerTextPending(ready), false);
    assert.equal(shouldAnalyzeBuyer(ready, "auto", true, false), true);
    assert.equal(shouldAnalyzeBuyer(ready, "auto", true, true), false);
    assert.equal(shouldAnalyzeBuyer(ready, false, true, false), false);
    assert.equal(shouldAnalyzeBuyer(ready, "auto", false, false), false);
  });
});
