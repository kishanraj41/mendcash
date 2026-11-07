import assert from "node:assert/strict";
import { it } from "node:test";
import { disputeStatusLabel } from "./status-label";
it("shows terminal outcomes and review state instead of a missing deadline", () => {
  assert.equal(disputeStatusLabel("RESOLVED", "RESOLVED_WITH_PAYOUT"), "Resolved · buyer refunded");
  assert.equal(disputeStatusLabel("RESOLVED", "RESOLVED_SELLER_FAVOUR"), "Resolved · seller won");
  assert.equal(disputeStatusLabel("CLOSED"), "Closed");
  assert.equal(disputeStatusLabel("RESOLVED"), "Resolved");
  assert.equal(disputeStatusLabel("UNDER_REVIEW"), "Under review");
  assert.equal(disputeStatusLabel("WAITING_FOR_SELLER_RESPONSE"), null);
});
