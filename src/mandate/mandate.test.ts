import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";
import { loadConfig } from "../config";
import { Desk } from "../services/desk";
import { createApp } from "../server";
import { buildAgenticScenario } from "../scenario/agentic";
import { customIdFor, transactionIdFromCustomId, verifyBundle, type AgentProof, type PayPalRecord } from "./ap2";
import { demoKeys, PUBLIC_DEMO_SEED } from "./keys";
import { mandateEvidencePdf } from "./pdf";
import { mentionsAgentPurchase } from "../agent/classify";

const NOW = () => new Date("2026-10-31T18:00:00.000Z");

function replayConfig(extra: Record<string, string> = {}) {
  return loadConfig({ MENDCASH_MODE: "replay", PAYPAL_BASE_URL: "https://api-m.sandbox.paypal.com", INVOICING_ENABLED: "false", PORT: "0", ...extra });
}

function recordOf(order: ReturnType<typeof buildAgenticScenario>[number]["order"]): PayPalRecord {
  const unit = order.purchase_units[0];
  const capture = unit.payments.captures[0];
  return {
    orderId: order.id,
    captureId: capture.id,
    customId: unit.custom_id || null,
    orderCreateTime: order.create_time,
    captureCents: Math.round(Number(capture.amount.value) * 100),
    currency: capture.amount.currency_code,
  };
}

describe("agent mandates", () => {
  const keys = demoKeys(PUBLIC_DEMO_SEED);
  const cases = buildAgenticScenario(keys);

  it("gives each planted agent dispute the expected verdict, decision, and agent flag", async () => {
    const desk = new Desk(replayConfig(), NOW);
    assert.equal(cases.length, 7);
    for (const row of cases) {
      const view = (await desk.getCase(row.expected.disputeId, "127.0.0.1")) as {
        agentProof: AgentProof | null;
        agentClaim: boolean;
        recommendation: { decision: string };
      };
      assert.equal(view.agentProof?.verdict, row.expected.verdict, row.expected.disputeId);
      assert.equal(view.recommendation.decision, row.expected.decision, row.expected.disputeId);
      assert.equal(view.agentClaim, row.expected.agentClaim, row.expected.disputeId);
    }
  });

  it("binds the mandate to PayPal through custom_id", () => {
    const authorized = cases[0];
    const customId = authorized.order.purchase_units[0].custom_id || "";
    assert.equal(customId, customIdFor(authorized.bundle!.transactionId));
    assert.equal(customId.length, 47);
    assert.equal(transactionIdFromCustomId(customId), authorized.bundle!.transactionId);
    assert.equal(transactionIdFromCustomId("order-123"), null);
  });

  it("fails integrity when any signed piece is edited", () => {
    const row = cases[0];
    const clean = verifyBundle(row.bundle, keys, recordOf(row.order));
    assert.equal(clean.verdict, "authorized");
    const parts = row.bundle!.closedPayment.split(".");
    const flipped = parts[1].slice(0, -2) + (parts[1].endsWith("A") ? "BB" : "AA");
    const tampered = { ...row.bundle!, closedPayment: [parts[0], flipped, parts[2]].join(".") };
    assert.equal(verifyBundle(tampered, keys, recordOf(row.order)).verdict, "integrity_failure");
    const otherKeys = demoKeys("a-different-seed");
    assert.equal(verifyBundle(row.bundle, otherKeys, recordOf(row.order)).verdict, "integrity_failure");
    const wrongAmount = { ...recordOf(row.order), captureCents: 1 };
    assert.equal(verifyBundle(row.bundle, keys, wrongAmount).verdict, "integrity_failure");
  });

  it("blocks the agent before payment when its pick is outside the mandate", async () => {
    const desk = new Desk(replayConfig(), NOW);
    const named = await desk.agentPurchase({ instruction: "Get the brand kit please", allowedIds: ["stickers"], maxUsd: "200" }, "10.0.0.1");
    assert.equal(named.status, "blocked");
    assert.equal(named.orderId, null);
    assert.ok(named.checks.some((check) => check.id === "allowed_item" && !check.pass));
    const pricey = await desk.agentPurchase({ instruction: "Get the brand kit please", allowedIds: ["brand-kit"], maxUsd: "50" }, "10.0.0.1");
    assert.equal(pricey.status, "blocked");
    assert.ok(pricey.checks.some((check) => check.id === "amount_range" && !check.pass));
    assert.equal(desk.agentPurchases().filter((row) => row.origin === "replay").length, 0, "blocked picks store nothing");
  });

  it("renders a deterministic PDF", async () => {
    const row = cases[0];
    const proof = verifyBundle(row.bundle, keys, recordOf(row.order));
    const input = {
      disputeId: row.expected.disputeId,
      reason: row.dispute.reason,
      stake: row.dispute.dispute_amount.value,
      currency: "USD",
      proof,
      paypal: { orderId: row.order.id, captureId: row.order.purchase_units[0].payments.captures[0].id, customId: row.order.purchase_units[0].custom_id || null, orderCreateTime: row.order.create_time },
      bundle: row.bundle,
      generatedAt: row.dispute.create_time,
    };
    const first = Buffer.from(await mandateEvidencePdf(input));
    const second = Buffer.from(await mandateEvidencePdf(input));
    assert.equal(first.subarray(0, 5).toString("latin1"), "%PDF-");
    assert.ok(first.equals(second));
  });

  it("spots agent purchases in buyer text without matching ordinary complaints", () => {
    assert.equal(mentionsAgentPurchase("My AI shopping assistant bought this without asking."), true);
    assert.equal(mentionsAgentPurchase("The agent at the store was rude. I bought it in person."), false);
    assert.equal(mentionsAgentPurchase("The package never arrived."), false);
  });

  it("runs the full replay loop: agent buys, buyer disputes, seller sends the PDF, PayPal decides, Recovered rises", async () => {
    const config = replayConfig();
    const desk = new Desk(config, NOW);
    const { app } = createApp({ config, desk, now: NOW });
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const sessionRes = await fetch(`${base}/api/session`);
      const session = (await sessionRes.json()) as { csrfToken: string; recoveredUsd: string };
      const cookie = (sessionRes.headers.get("set-cookie") || "").split(";")[0];
      const auth = { "Content-Type": "application/json", cookie, "x-mendcash-csrf": session.csrfToken, "x-mendcash-instant": "1" };

      const bought = (await (
        await fetch(`${base}/api/agent/purchase`, {
          method: "POST",
          headers: auth,
          body: JSON.stringify({ instruction: "Stickers for my laptop", allowedIds: ["stickers", "poster"], maxUsd: "20" }),
        })
      ).json()) as { status: string; transactionId: string; customId: string; orderId: string };
      assert.equal(bought.status, "bought");
      assert.equal(bought.customId, `ap2:${bought.transactionId}`);

      const mandate = await fetch(`${base}/api/ap2/checkout-mandates/${bought.transactionId}`);
      assert.equal(mandate.status, 200);

      const job = (await (
        await fetch(`${base}/api/agent/purchases/${bought.transactionId}/dispute?wait=1`, { method: "POST", headers: auth, body: "{}" })
      ).json()) as { disputeId: string; status: string };
      assert.equal(job.status, "done");

      const view = (await (await fetch(`${base}/api/disputes/${job.disputeId}`)).json()) as {
        agentClaim: boolean;
        agentProof: AgentProof;
        recommendation: { decision: string };
        sandbox: { available: boolean };
      };
      assert.equal(view.agentClaim, true);
      assert.equal(view.agentProof.verdict, "authorized");
      assert.equal(view.recommendation.decision, "contest");
      assert.equal(view.sandbox.available, false, "not UNDER_REVIEW yet");

      const early = await fetch(`${base}/api/disputes/${job.disputeId}/sandbox/adjudicate`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ outcome: "SELLER_FAVOR" }),
      });
      assert.equal(early.status, 409);

      const preview = (await (
        await fetch(`${base}/api/disputes/${job.disputeId}/preview`, { method: "POST", headers: auth, body: JSON.stringify({ action: "provide_evidence" }) })
      ).json()) as { payload: { body: { evidences: Array<{ documents?: Array<{ name: string }>; notes: string }> }; files: Array<Record<string, unknown>> } };
      assert.equal(preview.payload.files.length, 1);
      assert.equal(preview.payload.files[0].field, "evidence-file");
      assert.match(String(preview.payload.files[0].sha256), /^[0-9a-f]{64}$/);
      assert.equal("data" in preview.payload.files[0], false, "file bytes never reach the browser");
      assert.equal(preview.payload.body.evidences[0].documents?.[0]?.name, preview.payload.files[0].name);
      assert.match(preview.payload.body.evidences[0].notes, /custom_id ap2:/);

      const approved = await fetch(`${base}/api/disputes/${job.disputeId}/approve`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ action: "provide_evidence" }),
      });
      assert.equal(approved.status, 200);
      const approvedBody = (await approved.json()) as { payload: { files: Array<Record<string, unknown>> } };
      assert.equal("data" in approvedBody.payload.files[0], false);
      assert.equal(desk.writes.at(-1)?.files?.[0]?.name, "mendcash-agent-mandate.pdf");

      const decided = (await (
        await fetch(`${base}/api/disputes/${job.disputeId}/sandbox/adjudicate`, {
          method: "POST",
          headers: auth,
          body: JSON.stringify({ outcome: "SELLER_FAVOR" }),
        })
      ).json()) as { status: string; recoveredUsd: string };
      assert.equal(decided.status, "RESOLVED");
      assert.equal(Number(decided.recoveredUsd) - Number(session.recoveredUsd), 18);
      assert.equal(desk.sandboxCalls.length, 1);
      assert.equal(desk.writes.filter((call) => call.path.includes("adjudicate")).length, 0, "sandbox controls are not merchant writes");

      const pdf = await fetch(`${base}/api/disputes/${job.disputeId}/evidence.pdf`);
      assert.equal(pdf.headers.get("content-type"), "application/pdf");
      assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0, 5).toString("latin1"), "%PDF-");
    } finally {
      server.close();
    }
  });
});
