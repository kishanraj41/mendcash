import { createHash, randomUUID } from "crypto";
import os from "os";
import path from "path";
import { classifyClaim, claimLabel, mentionsAgentPurchase } from "../agent/classify";
import {
  closeMandates,
  customIdFor,
  evaluateConstraints,
  grantMandates,
  issueReceipts,
  publicBundle,
  signCheckout,
  transactionIdFromCustomId,
  verifyBundle,
  type AgentProof,
  type CheckoutPayload,
  type ConstraintCheck,
  type MandateBundle,
  type OpenCheckoutMandate,
  type OpenPaymentMandate,
  type PayPalRecord,
} from "../mandate/ap2";
import { pickWithModel, pickWithRules, type AgentPick } from "../mandate/agent";
import { decodeJws } from "../mandate/jws";
import { demoKeys, type DemoKeys } from "../mandate/keys";
import { EVIDENCE_PDF_NAME, mandateEvidencePdf } from "../mandate/pdf";
import { MandateStore } from "../mandate/store";
import { recommend } from "../money/decision";
import { buildAgenticScenario, DEMO_MERCHANT } from "../scenario/agentic";
import { buyerTextOf, planEvidence, refundIdOf } from "../agent/evidence";
import { stripModelMoney } from "../agent/injection";
import { createNebiusClient } from "../agent/llm";
import { readWithModel, readWithRules, type ReaderInput, type ReaderResult } from "../agent/reader";
import { prepareAction, type ActionName, type PreparedAction } from "../approval/payload";
import { ApprovalGate, type WriteCall, type WritePort } from "../approval/gate";
import { Limiter } from "../caps/limiter";
import { readSpendFile, writeSpendFile, type SpendFile, type StoredRead } from "../caps/state-file";
import type { AppConfig } from "../config";
import { modeLabel } from "../config";
import { formatUsdAmount, priceMicroUsd } from "../money/cost";
import { centsToMoney } from "../money/format";
import { computeFigures, type MoneyFacts } from "../money/engine";
import { PayPalRest } from "../paypal/rest";
import { cardOrderBody, processChargebackBody } from "../paypal/chargeback";
import { MISSING_MERCHANT_ID, orderWithMerchant } from "../paypal/merchant";
import { callToolkit, disputeItems, unwrap } from "../paypal/toolkit";
import { CATALOG, REASON_OPTIONS, reasonByCode, type CatalogItem } from "../scenario/catalog";
import { buildScenario, type FixtureDispute, type FixtureOrder } from "../scenario/planted";
import { isDemoReference } from "../demo-ref";
import { BUYER_PENDING_DETAIL, BUYER_PENDING_LABEL, buyerTextPending, listStatusTtlMs, newerListStatus, shouldAnalyzeBuyer, sortNewestFirst } from "./inbox";
import { previewInvoice, type Invoice, type InvoicePreview } from "./invoices";
import { StatusError } from "../errors";

export type TimelineEvent = {
  id: string;
  type: string;
  disputeId: string | null;
  at: string;
  summary: string;
  replay: boolean;
  verified: boolean;
};

export type SimStep = { id: string; label: string; state: "pending" | "active" | "done" | "error" };

export type SimJob = {
  id: string;
  status: "running" | "done" | "error";
  steps: SimStep[];
  disputeId: string | null;
  error: string | null;
  replay: boolean;
  note: string;
};

const SIM_STEPS = ["order", "chargeback", "waiting", "found"] as const;

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export class Desk {
  readonly gate: ApprovalGate;
  readonly limiter: Limiter;
  private readonly disputes = new Map<string, FixtureDispute>();
  private readonly orders = new Map<string, FixtureOrder>();
  private readonly captureToOrder = new Map<string, string>();
  private readonly reads = new Map<string, { version: string; result: ReaderResult }>();
  private readonly failedAt = new Map<string, number>();
  private readonly fillQueue: string[] = [];
  private readonly jobs = new Map<string, SimJob & { done: Promise<void> }>();
  private readonly timeline: TimelineEvent[] = [];
  private readonly fetchedAt = new Map<string, number>();
  private readonly createdIds = new Set<string>();
  private readonly submitted = new Map<string, number>();
  private readonly recovered = new Map<string, number>();
  private fillJob: Promise<void> | null = null;
  private initialScan: Promise<void> | null = null;
  private countersReady = false;
  private statePath: string | null = null;
  private writingState = false;
  private simSeq = 0;
  private readonly reader: (input: ReaderInput) => Promise<ReaderResult>;
  private readonly port: WritePort;
  readonly writes: WriteCall[] = [];
  /** Demo AP2 keys. The default seed is public, so signatures show integrity, not identity. */
  private readonly keys: DemoKeys;
  readonly mandates: MandateStore;
  /** Sandbox-only PayPal-side controls. Kept apart from merchant writes on purpose. */
  readonly sandboxCalls: Array<{ disputeId: string; kind: SandboxKind; outcome: string | null; at: string; replay: boolean }> = [];
  private agentSeq = 0;

  constructor(
    private readonly config: AppConfig,
    private readonly now: () => Date = () => new Date(),
    reader?: (input: ReaderInput) => Promise<ReaderResult>,
    private readonly rest: PayPalRest = new PayPalRest({ config, now }),
  ) {
    this.keys = demoKeys(config.mandate.keySeed);
    const explicitState = config.stateFile.trim();
    const mandateFile = explicitState
      ? path.join(path.dirname(explicitState), "mendcash-mandates.json")
      : config.mode === "live"
        ? path.join(os.tmpdir(), "mendcash-mandates.json")
        : null;
    this.mandates = new MandateStore(mandateFile);
    this.reader =
      reader ||
      (config.mode === "live" && config.nebius.configured
        ? (input) => readWithModel(input, createNebiusClient(config), config)
        : async (input) => readWithRules(input));
    this.port = {
      perform: async (call) => {
        const result = this.config.mode === "replay" ? await this.replayWrite(call) : await this.liveWrite(call);
        this.writes.push(call);
        if (this.config.mode === "live") {
          await this.fetchDispute(call.disputeId).catch((error: unknown) => {
            console.error(error instanceof Error ? error.message : "Dispute refresh after write failed.");
          });
        } else {
          const dispute = this.disputes.get(call.disputeId);
          if (dispute) this.syncMoney(dispute);
        }
        return result;
      },
    };
    this.gate = new ApprovalGate(this.port, {
      maxPartialRefundUsd: config.caps.maxPartialRefundUsd,
      maxSessionRefundUsd: config.caps.maxSessionRefundUsd,
    });
    this.limiter = new Limiter(config.caps, now);
    if (config.mode === "replay") this.loadReplay();
    this.countersReady = config.mode === "replay";
    this.bindState();
  }

  private loadReplay(): void {
    const scenario = buildScenario();
    for (const row of scenario.disputes) {
      const dispute = clone(row.dispute);
      const order = clone(row.order);
      this.disputes.set(dispute.dispute_id, dispute);
      this.orders.set(order.id, order);
      const capture = order.purchase_units[0]?.payments.captures[0]?.id;
      if (capture) this.captureToOrder.set(capture, order.id);
      this.createdIds.add(dispute.dispute_id);
      this.syncMoney(dispute);
    }
    // Agent-purchase disputes: signed mandate bundles bound to the order through custom_id.
    for (const row of buildAgenticScenario(this.keys)) {
      const dispute = clone(row.dispute);
      const order = clone(row.order);
      this.disputes.set(dispute.dispute_id, dispute);
      this.orders.set(order.id, order);
      const capture = order.purchase_units[0]?.payments.captures[0]?.id;
      if (capture) this.captureToOrder.set(capture, order.id);
      this.createdIds.add(dispute.dispute_id);
      if (row.bundle) this.mandates.put(row.bundle);
      this.syncMoney(dispute);
    }
    this.invoices = clone(scenario.invoices);
  }

  private invoices: Invoice[] = [];

  modeLabel(): string {
    return modeLabel(this.config);
  }

  submittedUsd(): string {
    return centsToMoney(this.sum(this.submitted));
  }

  recoveredUsd(): string {
    return centsToMoney(this.sum(this.recovered));
  }

  private sum(rows: Map<string, number>): number {
    let total = 0;
    for (const cents of rows.values()) total += cents;
    return Math.max(0, total);
  }

  private syncMoney(dispute: FixtureDispute): void {
    const id = dispute.dispute_id;
    if (!this.createdIds.has(id)) {
      this.submitted.delete(id);
      this.recovered.delete(id);
      return;
    }
    const facts = computeFigures(dispute, this.orderSync(dispute), this.now(), { replay: this.config.mode === "replay" });
    const cents = facts.stakeCents || 0;
    const outcome = (dispute as FixtureDispute & { dispute_outcome?: { outcome_code?: string } }).dispute_outcome?.outcome_code || "";
    if (dispute.status === "RESOLVED" && /SELLER/i.test(outcome)) {
      this.submitted.delete(id);
      if (cents) this.recovered.set(id, cents);
      return;
    }
    if (dispute.status === "RESOLVED") {
      this.submitted.delete(id);
      this.recovered.delete(id);
      return;
    }
    const sent = sellerSentEvidence(dispute);
    if (sent && cents) this.submitted.set(id, cents);
    else this.submitted.delete(id);
  }

  private fresh(id: string): boolean {
    if (this.config.mode === "replay") return this.disputes.has(id);
    const at = this.fetchedAt.get(id);
    if (at === undefined || !this.disputes.has(id)) return false;
    const dispute = this.disputes.get(id)!;
    const hot = dispute.status === "OPEN" || dispute.status === "UNDER_REVIEW" || dispute.status === "WAITING_FOR_SELLER_RESPONSE";
    return this.now().getTime() - at < (hot ? 8_000 : 30_000);
  }

  private remember(dispute: FixtureDispute): void {
    this.disputes.set(dispute.dispute_id, dispute);
    this.fetchedAt.set(dispute.dispute_id, this.now().getTime());
    this.syncMoney(dispute);
  }

  async ensureFresh(id: string): Promise<FixtureDispute> {
    return this.mustDispute(id);
  }

  private draftMeta(draft: ReaderResult): { model: string; usageSource: string; latencyMs: number; costUsd: string | null; label: string } {
    let costUsd: string | null = null;
    if (draft.usageSource === "model") {
      const segments = draft.segments?.length
        ? draft.segments
        : [
            { model: draft.model, usage: draft.usage },
            { model: this.config.nebius.routerModel, usage: draft.routerUsage },
          ];
      let micro = 0;
      for (const segment of segments) {
        const price = this.config.prices[segment.model];
        if (price && (segment.usage.prompt_tokens || segment.usage.completion_tokens)) {
          micro += priceMicroUsd(segment.usage, price);
        }
      }
      costUsd = formatUsdAmount(micro);
    }
    return {
      model: draft.model,
      usageSource: draft.usageSource,
      latencyMs: draft.latencyMs,
      costUsd,
      label:
        draft.usageSource === "model"
          ? draft.model
          : this.config.mode === "replay"
            ? "Rules draft. Replay does not call the model."
            : "Rules draft. The model runs on disputes this demo created.",
    };
  }

  private noteDemo(dispute: FixtureDispute, order: FixtureOrder | null): boolean {
    if (this.createdIds.has(dispute.dispute_id)) return true;
    const reference = order?.purchase_units?.[0]?.reference_id || "";
    if (!isDemoReference(reference)) return false;
    this.createdIds.add(dispute.dispute_id);
    this.syncMoney(dispute);
    return true;
  }

  private assertDemoDispute(dispute: FixtureDispute, order: FixtureOrder | null): void {
    if (this.noteDemo(dispute, order)) return;
    throw new StatusError("This demo only sends PayPal writes for disputes MendCash created. Nothing was sent.", 403);
  }

  async listDisputes(): Promise<Array<Record<string, unknown>>> {
    const disputes = sortNewestFirst(await this.allDisputes());
    return disputes.map((dispute) => {
      const order = this.orderSync(dispute);
      const facts = computeFigures(dispute, order, this.now(), { replay: this.config.mode === "replay" });
      const text = buyerTextOf(dispute);
      const pending = buyerTextPending(dispute);
      return {
        disputeId: dispute.dispute_id,
        reason: dispute.reason,
        status: dispute.status,
        lifecycle: dispute.dispute_life_cycle_stage,
        amount: facts.stake,
        currency: facts.currency,
        deadline: facts.deadline,
        simulatedDeadline: facts.simulatedDeadline,
        countdown: facts.countdown,
        snippet: pending ? BUYER_PENDING_DETAIL : text.slice(0, 110),
        claimLabel: pending ? BUYER_PENDING_LABEL : claimLabel(classifyClaim(dispute.reason, text, null)),
        pending,
        updated: dispute.update_time,
      };
    });
  }

  async atStakeUsd(): Promise<string> {
    let cents = 0;
    for (const dispute of this.disputes.values()) {
      if (!this.createdIds.has(dispute.dispute_id) || !awaitingResponse(dispute)) continue;
      const facts = computeFigures(dispute, this.orderSync(dispute), this.now(), { replay: this.config.mode === "replay" });
      cents += facts.stakeCents || 0;
    }
    return centsToMoney(cents);
  }

  async getCase(id: string, ip: string, analyze: boolean | "auto" = "auto"): Promise<Record<string, unknown>> {
    const dispute = await this.mustDispute(id);
    const order = await this.orderFor(dispute, this.config.mode === "live");
    const member = this.noteDemo(dispute, order);
    const facts = computeFigures(dispute, order, this.now(), { replay: this.config.mode === "replay" });
    const plan = planEvidence(dispute, order, refundIdOf(order, dispute));
    const pending = buyerTextPending(dispute);
    if (pending && this.reads.delete(dispute.dispute_id)) this.writeState();
    const version = buyerVersion(dispute);
    const cached = pending ? undefined : this.reads.get(dispute.dispute_id);
    const cacheHit = cached?.version === version ? cached.result : null;
    let draft: ReaderResult | null = cacheHit ?? (analyze === false ? cached?.result ?? null : null);
    let capError: string | null = null;
    const wantModel = shouldAnalyzeBuyer(dispute, analyze, member, Boolean(cacheHit));
    if (wantModel) {
      try {
        draft = await this.analyze(dispute, ip);
      } catch (error) {
        capError = error instanceof Error ? error.message : "Analysis failed.";
        if (!draft) draft = readWithRules(dispute);
      }
    } else if (!draft && !pending) {
      draft = readWithRules(dispute);
    }
    const narrative = draft ? stripModelMoney(draft.narrative) : "";
    const claimClass = draft
      ? classifyClaim(dispute.reason, draft.buyerText, draft.claimClass)
      : classifyClaim(dispute.reason, buyerTextOf(dispute), null);
    const agentClaim = !pending && (Boolean(draft?.agentClaim) || mentionsAgentPurchase(buyerTextOf(dispute)));
    const agentProof = this.proofFor(order, agentClaim);
    const recommendation = recommend({
      status: dispute.status,
      outcome: outcomeOf(dispute),
      claimClass,
      stakeCents: facts.stakeCents,
      currency: facts.currency,
      plan,
      proof: agentProof,
      sellerSent: sellerSentEvidence(dispute),
      // Replay deadlines are simulated, so a fixture date in the past is not a reason to fold.
      overdue: facts.countdown.overdue && !facts.countdown.simulated,
      smallClaimCents: Math.round(this.config.mandate.smallClaimUsd * 100),
    });
    return {
      agentClaim,
      agentProof,
      recommendation,
      sandbox: this.sandboxOptions(dispute, member),
      mode: this.config.mode,
      replay: this.config.mode === "replay",
      modeLabel: this.modeLabel(),
      dispute,
      order,
      buyerText: buyerTextOf(dispute),
      buyerPending: pending,
      injection: draft?.injection || { detected: false, patterns: [] },
      claimClass,
      claimLabel: pending ? BUYER_PENDING_LABEL : claimLabel(claimClass),
      draft: draft ? { ...this.draftMeta(draft), narrative } : null,
      capError,
      plan,
      figures: facts.figures,
      countdown: facts.countdown,
      records: {
        disputeId: facts.disputeId,
        captureId: facts.captureId,
        orderId: facts.orderId,
        trackerId: facts.trackerId,
      },
      timeline: this.timeline.filter((event) => event.disputeId === id),
    };
  }

  async preview(id: string, action: ActionName, fields: { partialAmount?: string; carrier?: string; trackingNumber?: string }): Promise<{
    payload?: PreparedAction;
    readOnly?: boolean;
    waiting?: boolean;
    reviewing?: boolean;
    message?: string;
  }> {
    const dispute = await this.mustDispute(id);
    const order = await this.orderFor(dispute, this.config.mode === "live");
    if (!this.noteDemo(dispute, order)) {
      return {
        readOnly: true,
        message: "Read only. This dispute was not created in this demo, so nothing can be sent.",
      };
    }
    if (sellerSentEvidence(dispute) && dispute.status === "UNDER_REVIEW") {
      return { reviewing: true, message: "Evidence sent. PayPal is reviewing." };
    }
    try {
      return { payload: await this.build(dispute, action, fields) };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Preview failed.";
      if (/not asking/i.test(message)) {
        if (sellerSentEvidence(dispute)) return { reviewing: true, message: "Evidence sent. PayPal is reviewing." };
        return { waiting: true, message };
      }
      throw error;
    }
  }

  async approve(
    id: string,
    action: ActionName,
    fields: { partialAmount?: string; carrier?: string; trackingNumber?: string },
    ip?: string,
  ): Promise<Record<string, unknown>> {
    const dispute = await this.mustDispute(id);
    const order = await this.orderFor(dispute, this.config.mode === "live");
    this.assertDemoDispute(dispute, order);
    const prepared = await this.build(dispute, action, fields);
    if (ip) this.limiter.takeApproval(ip);
    const facts = computeFigures(dispute, order, this.now(), { replay: this.config.mode === "replay" });
    const staged = this.gate.stage(id, prepared, this.now());
    const done = await this.gate.approve(staged.id, this.now(), facts);
    return {
      approvalId: done.id,
      executed: true,
      replay: this.config.mode === "replay",
      payload: done.prepared,
      result: done.result,
      recoveredUsd: this.recoveredUsd(),
      submittedUsd: this.submittedUsd(),
    };
  }

  invoicesView(): { enabled: boolean; invoices: InvoicePreview[]; note: string } {
    if (!this.config.invoicingEnabled) {
      return {
        enabled: false,
        invoices: [],
        note: "Invoice reminders are off. Invoicing is not enabled on the sandbox app yet. Set INVOICING_ENABLED=true after that feature is turned on.",
      };
    }
    return {
      enabled: true,
      invoices: this.invoices.map((invoice) => previewInvoice(invoice, this.now())),
      note:
        this.config.mode === "replay"
          ? "Replay invoices. Approving a reminder does not call PayPal."
          : "Live invoicing calls the PayPal toolkit only after you approve.",
    };
  }

  async approveInvoice(id: string, action: "send_invoice_reminder" | "create_early_payment_discount") {
    if (!this.config.invoicingEnabled) {
      throw new Error("Invoicing is disabled. Nothing was sent.");
    }
    const invoice = this.invoices.find((row) => row.id === id);
    if (!invoice) throw new Error("Invoice not found.");
    const preview = previewInvoice(invoice, this.now());
    const prepared = action === "send_invoice_reminder" ? preview.reminder : preview.discountRule;
    const facts = emptyFacts(id);
    const staged = this.gate.stage(id, prepared, this.now());
    const done = await this.gate.approve(staged.id, this.now(), facts);
    return { approvalId: done.id, payload: done.prepared, result: done.result, replay: this.config.mode === "replay" };
  }

  simulate(input: { itemId: string; reasonCode: string; complaint: string; orderId?: string }, ip: string, instant: boolean): {
    job: SimJob;
    done: Promise<void>;
  } {
    this.requireSandbox();
    const existing = input.orderId ? this.orders.get(input.orderId) || null : null;
    if (input.orderId && !existing) throw new Error("Order not found. Nothing was filed.");
    const item = CATALOG.find((row) => row.id === input.itemId);
    const reason = reasonByCode(input.reasonCode);
    if (!item) throw new Error("Pick an item from the catalog.");
    if (!reason) throw new Error("Pick a sandbox reason code.");
    const complaint = input.complaint.trim();
    if (complaint.length < 3 || complaint.length > 2000) {
      throw new Error("Type a buyer complaint between 3 and 2000 characters.");
    }
    this.limiter.takeSimulation(ip);
    let releaseQuota = true;
    const replay = this.config.mode === "replay";
    const job: SimJob = {
      id: `job-${randomUUID()}`,
      status: "running",
      steps: SIM_STEPS.map((id, index) => ({
        id,
        label: stepLabel(id, replay),
        state: index === 0 ? "active" : "pending",
      })),
      disputeId: null,
      error: null,
      replay,
      note: replay
        ? "Replay finishes without calling PayPal. A live sandbox chargeback usually takes about 40 seconds to show up."
        : "Sandbox simulation. A new dispute usually takes about 40 seconds to appear. Reason code 4853 is the one that becomes actionable. The page keeps asking PayPal for the new status.",
    };
    let resolveDone: () => void = () => undefined;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    this.jobs.set(job.id, { ...job, done });
    const run = (async () => {
      try {
        const disputeId = replay
          ? await this.replaySimulate(job, item, reason.reason, reason.code, complaint, instant, existing)
          : await this.liveSimulate(job, item, reason.code, complaint, existing);
        releaseQuota = false;
        job.disputeId = disputeId;
        job.status = "done";
        mark(job, "found", "done");
      } catch (error) {
        if (releaseQuota) this.limiter.releaseSimulation(ip);
        releaseQuota = false;
        job.status = "error";
        job.error = error instanceof Error ? error.message : "Simulation failed.";
        const active = job.steps.find((step) => step.state === "active");
        if (active) active.state = "error";
      } finally {
        const stored = this.jobs.get(job.id);
        if (stored) Object.assign(stored, job, { done });
        resolveDone();
      }
    })();
    void run;
    return { job, done };
  }

  job(id: string): SimJob | null {
    const stored = this.jobs.get(id);
    if (!stored) return null;
    return {
      id: stored.id,
      status: stored.status,
      steps: stored.steps,
      disputeId: stored.disputeId,
      error: stored.error,
      replay: stored.replay,
      note: stored.note,
    };
  }

  // ---------------------------------------------------------------------------
  // Agent purchases: AP2-shaped mandates bound to the PayPal order by custom_id.
  // ---------------------------------------------------------------------------

  /** Proof for an order. Null when the order has no ap2 custom_id and the buyer does not mention an agent. */
  private proofFor(order: FixtureOrder | null, agentClaim: boolean): AgentProof | null {
    const record = paypalRecordOf(order);
    if (!record.customId && !agentClaim) return null;
    return verifyBundle(this.mandates.get(transactionIdFromCustomId(record.customId)), this.keys, record);
  }

  private async mandateEvidence(
    dispute: FixtureDispute,
    order: FixtureOrder | null,
  ): Promise<{ note: string; attachment: { name: string; contentType: string; data: Uint8Array } } | null> {
    const proof = this.proofFor(order, false);
    // Only an authorized purchase is evidence for the seller. Anything else would argue against our own record.
    if (!proof || proof.verdict !== "authorized") return null;
    const data = await this.renderEvidencePdf(dispute, order, proof);
    return {
      note:
        `Agent purchase: the buyer's signed mandate authorized this order. PayPal custom_id ${proof.customId} on order ` +
        `${paypalRecordOf(order).orderId} matches the signed AP2 transaction_id, and all ${proof.checks.length} checks pass. Verification attached as ${EVIDENCE_PDF_NAME}.`,
      attachment: { name: EVIDENCE_PDF_NAME, contentType: "application/pdf", data },
    };
  }

  private renderEvidencePdf(dispute: FixtureDispute, order: FixtureOrder | null, proof: AgentProof): Promise<Uint8Array> {
    const record = paypalRecordOf(order);
    const facts = computeFigures(dispute, order, this.now(), { replay: this.config.mode === "replay" });
    return mandateEvidencePdf({
      disputeId: dispute.dispute_id,
      reason: dispute.reason,
      stake: facts.stake || "unknown",
      currency: facts.currency,
      proof,
      paypal: { orderId: record.orderId, captureId: record.captureId, customId: record.customId, orderCreateTime: record.orderCreateTime },
      bundle: this.mandates.get(proof.transactionId),
      // Pinned to the dispute record: the same dispute gives the same bytes, so the same PayPal-Request-Id.
      generatedAt: dispute.create_time || new Date(0).toISOString(),
    });
  }

  /** The verification PDF for any dispute with a mandate on its order (GET /api/disputes/:id/evidence.pdf). */
  async evidencePdf(id: string): Promise<Uint8Array> {
    const dispute = await this.mustDispute(id);
    const order = await this.orderFor(dispute, false);
    const proof = this.proofFor(order, true);
    if (!proof || proof.verdict === "no_mandate") throw new StatusError("No agent mandate is linked to this dispute.", 404);
    return this.renderEvidencePdf(dispute, order, proof);
  }

  /** Retrieval by AP2 transaction_id, the step AP2 v0.2 leaves out of scope. */
  mandateBundle(transactionId: string): Record<string, unknown> {
    const bundle = this.mandates.get(transactionId);
    if (!bundle) throw new StatusError("Mandate not found.", 404);
    return publicBundle(bundle);
  }

  agentPurchases(): Array<Record<string, unknown>> {
    return this.mandates.list().map((bundle) => ({
      transactionId: bundle.transactionId,
      instruction: bundle.instruction,
      createdAt: bundle.createdAt,
      origin: bundle.origin,
      paypal: bundle.paypal,
      disputeIds: [...this.disputes.values()]
        .filter((dispute) => bundle.paypal && this.orderSync(dispute)?.id === bundle.paypal.orderId)
        .map((dispute) => dispute.dispute_id),
    }));
  }

  /**
   * The buyer grants a mandate, the shopping agent picks, code checks the pick against the signed
   * mandate, and only then is a PayPal order created with custom_id = "ap2:" + transaction_id.
   */
  async agentPurchase(input: { instruction: string; allowedIds: string[]; maxUsd: string }, ip: string): Promise<AgentPurchaseResult> {
    this.requireSandbox();
    const instruction = input.instruction.trim();
    if (instruction.length < 3 || instruction.length > 500) throw new Error("Type a shopping instruction between 3 and 500 characters.");
    const allowed = CATALOG.filter((item) => input.allowedIds.includes(item.id));
    if (!allowed.length) throw new Error("Allow at least one catalog item.");
    const maxCents = Math.round(Number(input.maxUsd) * 100);
    if (!Number.isFinite(maxCents) || maxCents < 100 || maxCents > 50_000) throw new Error("Set a spending limit between 1 and 500 USD.");
    this.limiter.takeSimulation(ip);
    let keepQuota = false;
    try {
      const result = await this.runAgentPurchase(instruction, allowed, maxCents, ip);
      keepQuota = result.status === "bought";
      return result;
    } finally {
      if (!keepQuota) this.limiter.releaseSimulation(ip);
    }
  }

  private async runAgentPurchase(instruction: string, allowed: CatalogItem[], maxCents: number, ip: string): Promise<AgentPurchaseResult> {
    const replay = this.config.mode === "replay";
    const now = this.now();
    const at = now.toISOString();
    const iat = Math.floor(now.getTime() / 1000);
    const steps: AgentStep[] = [];
    const log = (step: string, detail: string, state: AgentStep["state"] = "done") => steps.push({ at, step, detail, state });

    const grant = grantMandates(this.keys, {
      subject: "demo-buyer",
      instruction,
      merchant: DEMO_MERCHANT,
      items: allowed.map(({ id, title }) => ({ id, title })),
      quantity: 1,
      maxCents,
      currency: "USD",
      iat,
      exp: iat + 7 * 86_400,
    });
    log("mandate", `Buyer signed open mandates: ${allowed.map((item) => item.title).join(", ")}, quantity 1, up to ${centsToMoney(maxCents)} USD, valid 7 days.`);

    const pick = await this.agentPick(instruction, allowed.map((item) => item.id), centsToMoney(maxCents), ip);
    const item = CATALOG.find((row) => row.id === pick.itemId) || allowed[0];
    log("pick", `Agent picked ${pick.quantity} x ${item.title} (${pick.source === "model" ? pick.model : "replay rules"}). ${pick.reason}`);

    this.agentSeq += 1;
    const n = String(this.agentSeq).padStart(4, "0");
    const unitCents = Math.round(Number(item.amount) * 100);
    const checkoutJwt = signCheckout(this.keys, {
      id: `chk-${iat}-${n}`,
      merchant: DEMO_MERCHANT,
      item: { id: item.id, title: item.title },
      unitCents,
      quantity: pick.quantity,
      currency: "USD",
      iat,
    });
    log("checkout", `Merchant signed the cart: ${pick.quantity} x ${item.title}, ${centsToMoney(unitCents * pick.quantity)} USD.`);

    const checks = evaluateConstraints(
      decodeJws<OpenCheckoutMandate>(grant.openCheckout).payload,
      decodeJws<OpenPaymentMandate>(grant.openPayment).payload,
      decodeJws<CheckoutPayload>(checkoutJwt).payload,
      iat,
    );
    const failed = checks.filter((check) => !check.pass);
    const base = { replay, pick: { ...pick, title: item.title }, checks };
    if (failed.length) {
      log("guard", `Blocked before payment: ${failed.map((check) => check.label).join("; ")}. No order was created.`, "blocked");
      return { ...base, status: "blocked", steps, transactionId: null, customId: null, orderId: null, captureId: null };
    }
    log("guard", `All ${checks.length} mandate checks pass, so the agent may pay.`);

    const closed = closeMandates(this.keys, { checkoutJwt, payee: DEMO_MERCHANT, instrument: "Sandbox test card", iat, exp: iat + 3_600 });
    const customId = customIdFor(closed.transactionId);
    log("sign", `Agent signed the closed checkout and payment mandates. transaction_id ${closed.transactionId}.`);

    const placed = replay
      ? this.replayAgentOrder(n, item, pick.quantity, customId)
      : await this.liveAgentOrder(item, pick.quantity, customId);
    log("order", `${replay ? "Replay order" : "PayPal sandbox order"} ${placed.orderId}, capture ${placed.captureId}, custom_id ${customId}.`);

    const receipts = issueReceipts(this.keys, {
      closedCheckout: closed.closedCheckout,
      closedPayment: closed.closedPayment,
      orderId: placed.orderId,
      captureId: placed.captureId,
      iat,
    });
    log("receipt", "Merchant receipts bind the closed mandates to the PayPal order and capture.");

    const bundle: MandateBundle = {
      version: 1,
      transactionId: closed.transactionId,
      openCheckout: grant.openCheckout,
      openPayment: grant.openPayment,
      checkoutJwt,
      closedCheckout: closed.closedCheckout,
      closedPayment: closed.closedPayment,
      checkoutReceipt: receipts.checkoutReceipt,
      paymentReceipt: receipts.paymentReceipt,
      paypal: { orderId: placed.orderId, captureId: placed.captureId, customId, createdAt: placed.createdAt },
      instruction,
      steps: steps.map(({ at: stepAt, step, detail }) => ({ at: stepAt, step, detail })),
      createdAt: at,
      origin: replay ? "replay" : "live",
    };
    this.mandates.put(bundle);
    return {
      ...base,
      status: "bought",
      steps,
      transactionId: closed.transactionId,
      customId,
      orderId: placed.orderId,
      captureId: placed.captureId,
    };
  }

  private async agentPick(instruction: string, allowedIds: string[], maxUsd: string, ip: string): Promise<AgentPick> {
    if (this.config.mode === "live" && this.config.nebius.configured) {
      const reservation = this.limiter.reserveAnalysis(ip, Math.round(this.config.caps.reserveUsd * 1_000_000));
      try {
        const pick = await this.limiter.withSlot(() =>
          pickWithModel({ instruction, catalog: CATALOG, allowedIds, maxUsd, model: this.config.nebius.agentModel }, createNebiusClient(this.config)),
        );
        const price = this.config.prices[pick.model];
        reservation.commit(price && pick.usage.prompt_tokens ? priceMicroUsd(pick.usage, price) : 0);
        return pick;
      } catch (error) {
        reservation.cancel();
        console.error(error instanceof Error ? error.message : "Shopping agent call failed; using rules.");
      }
    }
    return pickWithRules(instruction, CATALOG, allowedIds);
  }

  private replayAgentOrder(n: string, item: CatalogItem, quantity: number, customId: string): { orderId: string; captureId: string; createdAt: string } {
    const orderId = `MCAGT${n}ORD`;
    const captureId = `MCAGT${n}CAP`;
    const value = centsToMoney(Math.round(Number(item.amount) * 100) * quantity);
    const money = { currency_code: "USD", value };
    const at = this.now().toISOString();
    const tracking = `1ZMCAGT${n}`;
    const order: FixtureOrder = {
      id: orderId,
      intent: "CAPTURE",
      status: "COMPLETED",
      purchase_units: [
        {
          reference_id: `sim-${8000 + this.agentSeq}`,
          description: item.title,
          custom_id: customId,
          amount: money,
          payee: { email_address: "merchant@example.com", merchant_id: DEMO_MERCHANT.id },
          ...(item.kind === "physical"
            ? { shipping: { trackers: [{ id: `${captureId}-${tracking}`, status: "SHIPPED", carrier: "UPS", tracking_number: tracking }] } }
            : {}),
          payments: {
            captures: [
              {
                id: captureId,
                status: "COMPLETED",
                amount: money,
                final_capture: true,
                seller_receivable_breakdown: { gross_amount: money, paypal_fee: { currency_code: "USD", value: "0.00" }, net_amount: money },
              },
            ],
          },
        },
      ],
      create_time: at,
      update_time: at,
    };
    this.orders.set(orderId, order);
    this.captureToOrder.set(captureId, orderId);
    return { orderId, captureId, createdAt: at };
  }

  private async liveAgentOrder(item: CatalogItem, quantity: number, customId: string): Promise<{ orderId: string; captureId: string; createdAt: string }> {
    const reference = `mendcash-${Date.now()}`;
    const amount = centsToMoney(Math.round(Number(item.amount) * 100) * quantity);
    const created = await this.rest.json(
      "POST",
      "/v2/checkout/orders",
      cardOrderBody({ item, reference, card: this.config.paypal.testCard, customId, amount }),
      { "PayPal-Request-Id": reference, Prefer: "return=representation" },
    );
    const resolved = await orderWithMerchant(this.rest, created, this.config.paypal.merchantId);
    const order = resolved.order as unknown as FixtureOrder;
    const orderId = stringOf(order.id);
    const captureId = stringOf(order.purchase_units?.[0]?.payments?.captures?.[0]?.id);
    if (!orderId || !captureId) throw new Error("PayPal created no capture on the agent order. Nothing was signed as paid.");
    this.orders.set(orderId, order);
    this.captureToOrder.set(captureId, orderId);
    return { orderId, captureId, createdAt: stringOf(order.create_time) || this.now().toISOString() };
  }

  /** Card orders and chargebacks use a test card: allowed in replay or against the PayPal sandbox only. */
  private requireSandbox(): void {
    if (this.config.mode === "live" && !this.config.sandbox) {
      throw new StatusError("Simulated purchases and chargebacks run only against the PayPal sandbox. Nothing was sent.", 409);
    }
  }

  /** The buyer disputes the agent's purchase: a 4853 chargeback against that same capture. */
  disputeAgentPurchase(transactionId: string, complaint: string, ip: string, instant: boolean): { job: SimJob; done: Promise<void> } {
    const bundle = this.mandates.get(transactionId);
    if (!bundle?.paypal) throw new StatusError("Agent purchase not found.", 404);
    const order = this.orders.get(bundle.paypal.orderId);
    if (!order) throw new StatusError("This server does not hold the order for that agent purchase. Nothing was filed.", 404);
    const itemId = decodeJws<CheckoutPayload>(bundle.checkoutJwt).payload.line_items[0]?.id || "";
    const text = complaint.trim() || "I never agreed to this purchase. My AI shopping assistant bought it on its own.";
    return this.simulate({ itemId, reasonCode: "4853", complaint: text, orderId: order.id }, ip, instant);
  }

  private sandboxOptions(dispute: FixtureDispute, member: boolean): { available: boolean; reason: string; linkListed: boolean } {
    const replay = this.config.mode === "replay";
    const linkListed = (dispute.links || []).some((link) => /adjudicate|require[-_]evidence/i.test(link.rel || ""));
    if (!replay && !this.config.sandbox) return { available: false, reason: "PayPal-side controls exist only in the sandbox.", linkListed };
    if (!member) return { available: false, reason: "Only for disputes this demo created.", linkListed };
    if (dispute.status !== "UNDER_REVIEW") {
      return { available: false, reason: "PayPal accepts these controls only while the dispute is UNDER_REVIEW.", linkListed };
    }
    return {
      available: true,
      reason: replay
        ? "Replay: moves the fixture the way PayPal would. No PayPal call."
        : "Sandbox only: asks PayPal to act as its own dispute team. Merchants cannot do this in production.",
      linkListed,
    };
  }

  /** Sandbox-only PayPal-side moves: ask the seller for evidence again, or decide the dispute. */
  async sandboxControl(id: string, kind: SandboxKind, outcome: string | null, ip: string): Promise<Record<string, unknown>> {
    const dispute = await this.mustDispute(id);
    const order = await this.orderFor(dispute, false);
    const options = this.sandboxOptions(dispute, this.noteDemo(dispute, order));
    if (!options.available) throw new StatusError(`${options.reason} Nothing was sent.`, 409);
    if (kind === "adjudicate" && outcome !== "SELLER_FAVOR" && outcome !== "BUYER_FAVOR") {
      throw new Error("Pick SELLER_FAVOR or BUYER_FAVOR.");
    }
    this.limiter.takeApproval(ip);
    const replay = this.config.mode === "replay";
    const path = `/v1/customer/disputes/${id}/${kind === "adjudicate" ? "adjudicate" : "require-evidence"}`;
    const body = kind === "adjudicate" ? { adjudication_outcome: outcome } : { action: "SELLER_EVIDENCE" };
    if (replay) {
      this.replaySandbox(dispute, kind, outcome);
      this.syncMoney(dispute);
    } else {
      await this.rest.json("POST", path, body, { "PayPal-Request-Id": `mendcash-sbx-${randomUUID()}` });
      await this.fetchDispute(id).catch((error: unknown) => {
        console.error(error instanceof Error ? error.message : "Dispute refresh after sandbox control failed.");
      });
    }
    this.sandboxCalls.push({ disputeId: id, kind, outcome, at: this.now().toISOString(), replay });
    return {
      replay,
      path,
      body,
      status: this.disputes.get(id)?.status || null,
      recoveredUsd: this.recoveredUsd(),
      submittedUsd: this.submittedUsd(),
    };
  }

  private replaySandbox(dispute: FixtureDispute, kind: SandboxKind, outcome: string | null): void {
    const now = this.now();
    const at = now.toISOString();
    if (kind === "require_evidence") {
      dispute.status = "WAITING_FOR_SELLER_RESPONSE";
      dispute.dispute_state = "REQUIRED_ACTION";
      dispute.seller_response_due_date = new Date(now.getTime() + 10 * 86_400_000).toISOString();
      dispute.evidences.push({
        evidence_type: "OTHER",
        source: "REQUESTED_FROM_SELLER",
        date: at,
        dispute_life_cycle_stage: dispute.dispute_life_cycle_stage || "CHARGEBACK",
      });
      if (!dispute.links.some((link) => link.rel === "provide_evidence")) {
        dispute.links.push({
          href: `https://api-m.sandbox.paypal.com/v1/customer/disputes/${dispute.dispute_id}/provide-evidence`,
          rel: "provide_evidence",
          method: "POST",
        });
      }
    } else {
      dispute.status = "RESOLVED";
      dispute.dispute_state = "RESOLVED";
      (dispute as FixtureDispute & { dispute_outcome?: { outcome_code: string } }).dispute_outcome = {
        outcome_code: outcome === "SELLER_FAVOR" ? "RESOLVED_SELLER_FAVOUR" : "RESOLVED_BUYER_FAVOUR",
      };
    }
    dispute.update_time = at;
    this.timeline.push({
      id: `wh-${randomUUID()}`,
      type: kind === "adjudicate" ? "CUSTOMER.DISPUTE.RESOLVED" : "CUSTOMER.DISPUTE.UPDATED",
      disputeId: dispute.dispute_id,
      at,
      summary: kind === "adjudicate" ? `Replay: PayPal decided ${outcome === "SELLER_FAVOR" ? "for the seller" : "for the buyer"}` : "Replay: PayPal asked the seller for evidence",
      replay: true,
      verified: false,
    });
  }

  async verifyAndIngest(headers: Record<string, string | undefined>, event: Record<string, unknown>, replayHeader: boolean): Promise<TimelineEvent> {
    if (this.config.mode === "replay") {
      if (!replayHeader) throw new Error("Replay webhook rejected. Live PayPal signatures are not assumed in replay.");
      return this.ingestWebhook(event, false, true);
    }
    const { verifyWebhookSignature } = await import("../paypal/webhook");
    const ok = await verifyWebhookSignature(this.rest, this.config, headers, event);
    if (!ok) throw new Error("PayPal webhook signature was not verified. Nothing was stored.");
    return this.ingestWebhook(event, true, false);
  }

  timelineAll(): TimelineEvent[] {
    return [...this.timeline].reverse();
  }

  ingestWebhook(event: Record<string, unknown>, verified: boolean, replay: boolean): TimelineEvent {
    const resource = isRecord(event.resource) ? event.resource : {};
    const disputeId = typeof resource.dispute_id === "string" ? resource.dispute_id : null;
    const row: TimelineEvent = {
      id: typeof event.id === "string" ? event.id : `wh-${randomUUID()}`,
      type: typeof event.event_type === "string" ? event.event_type : "UNKNOWN",
      disputeId,
      at: this.now().toISOString(),
      summary: typeof event.summary === "string" ? event.summary : "Dispute event",
      replay,
      verified,
    };
    this.timeline.push(row);
    if (disputeId) this.fetchedAt.delete(disputeId);
    if (disputeId && this.disputes.has(disputeId)) {
      const dispute = this.disputes.get(disputeId)!;
      if (typeof resource.status === "string") dispute.status = resource.status;
      if (typeof resource.seller_response_due_date === "string") {
        dispute.seller_response_due_date = resource.seller_response_due_date;
      }
      if (isRecord(resource.dispute_amount) && typeof resource.dispute_amount.value === "string") {
        dispute.dispute_amount = {
          currency_code: typeof resource.dispute_amount.currency_code === "string" ? resource.dispute_amount.currency_code : "USD",
          value: resource.dispute_amount.value,
        };
      }
      dispute.update_time = row.at;
      this.syncMoney(dispute);
    }
    return row;
  }

  catalog() {
    return { items: CATALOG, reasons: REASON_OPTIONS };
  }

  session() {
    return {
      mode: this.config.mode,
      replay: this.config.mode === "replay",
      modeLabel: this.modeLabel(),
      sandbox: this.config.sandbox,
      invoicingEnabled: this.config.invoicingEnabled,
      webhooksConfigured: Boolean(this.config.paypal.webhookId),
      recoveredUsd: this.recoveredUsd(),
      submittedUsd: this.submittedUsd(),
      caps: {
        maxDailyUsd: this.config.caps.maxDailyUsd,
        analysesPerIp: this.config.caps.analysesPerIp,
        simulationsPerIp: this.config.caps.simulationsPerIp,
      },
      models: {
        agent: this.config.nebius.agentModel,
        router: this.config.nebius.routerModel,
        fallback: this.config.nebius.fallbackModel,
      },
      spendTodayUsd: this.limiter.spentUsd.toFixed(6),
      countersReady: this.countersReady,
    };
  }

  private bindState(): void {
    const explicit = this.config.stateFile.trim();
    const file = explicit || (this.config.mode === "live" ? path.join(os.tmpdir(), "mendcash-spend.json") : "");
    if (!file) return;
    this.statePath = file;
    const saved = readSpendFile(file);
    if (saved) {
      this.limiter.hydrate(saved);
      for (const [id, row] of Object.entries(saved.reads)) this.reads.set(id, row);
    }
    this.limiter.setListener(() => this.writeState());
  }

  private writeState(): void {
    if (!this.statePath || this.writingState) return;
    this.writingState = true;
    try {
      const spend = this.limiter.exportState();
      const reads: Record<string, StoredRead> = Object.create(null);
      for (const [id, row] of this.reads) {
        if (row.result.usageSource === "rules") continue;
        reads[id] = row;
      }
      const body: SpendFile = { version: 1, ...spend, reads };
      writeSpendFile(this.statePath, body);
    } catch (error) {
      console.error(error instanceof Error ? error.message : "Could not save the spend file.");
    } finally {
      this.writingState = false;
    }
  }

  private async analyze(dispute: FixtureDispute, ip: string): Promise<ReaderResult> {
    const reserveMicro = Math.round(this.config.caps.reserveUsd * 1_000_000);
    const reservation = this.limiter.reserveAnalysis(ip, reserveMicro);
    try {
      const result = await this.limiter.withSlot(() => this.reader(dispute));
      const prices = this.config.prices;
      const agentPrice = prices[this.config.nebius.agentModel];
      const routerPrice = prices[this.config.nebius.routerModel];
      const micro =
        (result.usageSource === "rules" ? 0 : priceMicroUsd(result.usage, agentPrice)) +
        (result.routerUsage.prompt_tokens ? priceMicroUsd(result.routerUsage, routerPrice) : 0);
      const reconciled = classifyClaim(dispute.reason, result.buyerText, result.claimClass);
      const stored = { ...result, claimClass: reconciled, claimLabel: claimLabel(reconciled), narrative: stripModelMoney(result.narrative) };
      this.reads.set(dispute.dispute_id, { version: buyerVersion(dispute), result: stored });
      reservation.commit(micro);
      if (stored.usageSource !== "rules") this.writeState();
      return stored;
    } catch (error) {
      reservation.cancel();
      throw error;
    }
  }

  private async build(
    dispute: FixtureDispute,
    action: ActionName,
    fields: { partialAmount?: string; carrier?: string; trackingNumber?: string },
  ): Promise<PreparedAction> {
    const order = this.orderSync(dispute);
    const facts = computeFigures(dispute, order, this.now(), { replay: this.config.mode === "replay" });
    const plan = planEvidence(dispute, order, refundIdOf(order, dispute));
    const draft = this.reads.get(dispute.dispute_id)?.result;
    const narrative = stripModelMoney(draft?.narrative || readWithRules(dispute).narrative);
    const claimClass = classifyClaim(dispute.reason, buyerTextOf(dispute), draft?.claimClass || null);
    const mandate = action === "provide_evidence" ? await this.mandateEvidence(dispute, order) : null;
    return prepareAction({
      mandateNote: mandate?.note,
      attachment: mandate?.attachment,
      dispute,
      order,
      facts,
      plan,
      narrative,
      claimClass,
      action,
      partialAmount: fields.partialAmount,
      carrier: fields.carrier,
      trackingNumber: fields.trackingNumber,
      caps: { maxPartialRefundUsd: this.config.caps.maxPartialRefundUsd },
    });
  }

  private async allDisputes(): Promise<FixtureDispute[]> {
    if (this.config.mode === "replay") return [...this.disputes.values()];
    const listed = await this.listDisputePages();
    const rows: FixtureDispute[] = [];
    const missing: string[] = [];
    const stale: string[] = [];
    for (const row of listed) {
      const id = typeof row.dispute_id === "string" ? row.dispute_id : "";
      if (!id) continue;
      const cached = this.disputes.get(id);
      if (cached) {
        const listedStatus = typeof row.status === "string" ? row.status : "";
        const listedAt = typeof row.update_time === "string" ? row.update_time : "";
        const next = newerListStatus(cached, { status: listedStatus, update_time: listedAt });
        if (next.status !== cached.status || (next.update_time && next.update_time !== cached.update_time)) {
          cached.status = next.status;
          if (next.update_time) cached.update_time = next.update_time;
          this.syncMoney(cached);
        }
        rows.push(cached);
        if (!this.listFresh(id)) stale.push(id);
      } else {
        rows.push(summaryDispute(row));
        const failed = this.failedAt.get(id) || 0;
        if (this.now().getTime() - failed > 30_000) missing.push(id);
      }
    }
    for (const local of this.disputes.values()) {
      if (!rows.some((row) => row.dispute_id === local.dispute_id)) rows.push(local);
    }
    if (missing.length) this.watchCounters(this.fillMissing(missing));
    if (stale.length) void this.fillMissing(stale);
    if (!missing.length && !this.countersReady) this.countersReady = true;
    return rows;
  }

  private watchCounters(job: Promise<void>): void {
    if (this.config.mode !== "live" || this.countersReady || this.initialScan) return;
    this.initialScan = job.then(
      () => {
        this.countersReady = true;
      },
      () => {
        this.countersReady = true;
      },
    );
  }

  private listFresh(id: string): boolean {
    const at = this.fetchedAt.get(id);
    const dispute = this.disputes.get(id);
    if (at === undefined || !dispute) return false;
    return this.now().getTime() - at < listStatusTtlMs(dispute.status);
  }

  private async listDisputePages(): Promise<Array<Record<string, unknown>>> {
    const seen = new Set<string>();
    const all: Array<Record<string, unknown>> = [];
    for (let page = 1; page <= 8; page += 1) {
      const listed = disputeItems(await callToolkit(this.config, "list_disputes", { page_size: 50, page }));
      if (!listed.length) break;
      let added = 0;
      for (const row of listed) {
        const id = typeof row.dispute_id === "string" ? row.dispute_id : "";
        if (!id || seen.has(id)) continue;
        seen.add(id);
        all.push(row);
        added += 1;
      }
      if (added === 0 || listed.length < 50) break;
    }
    return all;
  }

  private fillMissing(ids: string[]): Promise<void> {
    for (const id of ids) {
      if (id && !this.fillQueue.includes(id)) this.fillQueue.push(id);
    }
    if (this.fillJob) return this.fillJob;
    const workers = Math.min(5, Math.max(1, this.fillQueue.length));
    this.fillJob = (async () => {
      await Promise.all(Array.from({ length: workers }, () => this.drainFill()));
    })().finally(() => {
      this.fillJob = null;
    });
    return this.fillJob;
  }

  private async drainFill(): Promise<void> {
    while (this.fillQueue.length) {
      const id = this.fillQueue.shift();
      if (!id || this.fresh(id)) continue;
      try {
        const dispute = await this.fetchDispute(id);
        this.failedAt.delete(id);
        if (!this.createdIds.has(id)) {
          const order = await this.orderFor(dispute, false);
          this.noteDemo(dispute, order);
        }
      } catch (error) {
        this.failedAt.set(id, this.now().getTime());
        console.error(error instanceof Error ? error.message : "Dispute refresh failed.");
      }
    }
  }

  private async fetchDispute(id: string): Promise<FixtureDispute> {
    const detail = unwrap(await callToolkit(this.config, "get_dispute", { dispute_id: id }));
    if (!isRecord(detail) || typeof detail.dispute_id !== "string") throw new Error("Dispute not found.");
    const dispute = detail as unknown as FixtureDispute;
    this.remember(dispute);
    return dispute;
  }

  private async mustDispute(id: string): Promise<FixtureDispute> {
    if (this.config.mode === "replay") {
      const dispute = this.disputes.get(id);
      if (!dispute) throw new Error("Dispute not found.");
      return dispute;
    }
    if (this.fresh(id)) return this.disputes.get(id)!;
    return this.fetchDispute(id);
  }

  private orderSync(dispute: FixtureDispute): FixtureOrder | null {
    const capture = dispute.disputed_transactions?.[0]?.seller_transaction_id;
    const orderId = (capture && this.captureToOrder.get(capture)) || dispute.extensions?.mendcash_order_id;
    return orderId ? this.orders.get(orderId) || null : null;
  }

  private async orderFor(dispute: FixtureDispute, force = false): Promise<FixtureOrder | null> {
    const cached = this.orderSync(dispute);
    if (this.config.mode === "replay") return cached;
    if (cached && !force) return cached;
    const capture = dispute.disputed_transactions?.[0]?.seller_transaction_id;
    if (!capture) return null;
    const cap = (await this.rest.json("GET", `/v2/payments/captures/${capture}`)) as {
      links?: Array<{ rel?: string; href?: string }>;
    };
    const up = cap.links?.find((link) => link.rel === "up")?.href || "";
    const orderId = up.split("/").filter(Boolean).pop();
    if (!orderId) return null;
    const order = unwrap(await callToolkit(this.config, "get_order", { id: orderId })) as FixtureOrder;
    if (order?.id) {
      this.orders.set(order.id, order);
      this.captureToOrder.set(capture, order.id);
    }
    return order || null;
  }

  private async replayWrite(call: WriteCall): Promise<{ status: number; body: unknown }> {
    const dispute = this.disputes.get(call.disputeId);
    if (dispute && call.action === "provide_evidence") {
      const evidences = (call.body.evidences as Array<Record<string, unknown>>) || [];
      for (const evidence of evidences) {
        dispute.evidences.push({
          evidence_type: String(evidence.evidence_type || "OTHER"),
          notes: typeof evidence.notes === "string" ? evidence.notes : undefined,
          source: "SUBMITTED_BY_SELLER",
          date: this.now().toISOString(),
          dispute_life_cycle_stage: "CHARGEBACK",
          ...(Array.isArray(evidence.documents) ? { documents: evidence.documents as Array<{ name: string }> } : {}),
        } as FixtureDispute["evidences"][number]);
      }
      dispute.status = "UNDER_REVIEW";
      dispute.dispute_state = "UNDER_PAYPAL_REVIEW";
      dispute.links = dispute.links.filter((link) => link.rel !== "provide_evidence");
      dispute.update_time = this.now().toISOString();
    }
    if (dispute && (call.action === "accept_claim" || call.action === "partial_refund")) {
      dispute.status = "RESOLVED";
      dispute.update_time = this.now().toISOString();
    }
    if (call.action === "add_tracking") {
      const orderId = call.path.split("/")[4];
      const order = orderId ? this.orders.get(orderId) : undefined;
      const body = call.body as { tracking_number?: string; carrier?: string; capture_id?: string };
      if (order && body.tracking_number && body.carrier) {
        const unit = order.purchase_units[0];
        unit.shipping = {
          trackers: [
            {
              id: `${body.capture_id || "cap"}-${body.tracking_number}`,
              status: "SHIPPED",
              carrier: body.carrier,
              tracking_number: body.tracking_number,
            },
          ],
        };
      }
    }
    return { status: 200, body: { replay: true, path: call.path } };
  }

  private async liveWrite(call: WriteCall): Promise<{ status: number; body: unknown }> {
    if (call.action === "provide_evidence") {
      const files = (call.files || []).map((file) => ({
        field: file.field,
        name: file.name,
        contentType: file.contentType,
        data: Buffer.from(file.data, "base64"),
      }));
      const body = await this.rest.multipart(call.path, call.body, call.requestId, files);
      return { status: 200, body };
    }
    if (call.action === "send_invoice_reminder") {
      const body = await callToolkit(this.config, "send_invoice_reminder", call.body);
      return { status: 200, body };
    }
    if (call.action === "create_early_payment_discount") {
      const body = await callToolkit(this.config, "create_conditional_rules_for_invoice", call.body);
      return { status: 200, body };
    }
    const body = await this.rest.json("POST", call.path, call.body, { "PayPal-Request-Id": call.requestId });
    return { status: 200, body };
  }

  private async replaySimulate(
    job: SimJob,
    item: CatalogItem,
    reason: string,
    code: string,
    complaint: string,
    instant: boolean,
    existing: FixtureOrder | null = null,
  ): Promise<string> {
    const wait = async (ms: number) => {
      if (!instant && ms) await new Promise((resolve) => setTimeout(resolve, ms));
    };
    mark(job, "order", "active");
    await wait(instant ? 0 : 250);
    this.simSeq += 1;
    const n = String(this.simSeq).padStart(4, "0");
    const orderId = existing?.id || `MCSIM${n}ORD`;
    const captureId = existing?.purchase_units[0]?.payments.captures[0]?.id || `MCSIM${n}CAP`;
    const disputeId = `PP-R-SIM-${n}`;
    const tracking = item.kind === "physical" ? { carrier: "UPS", number: `1ZMCRPLY${n}` } : null;
    const order: FixtureOrder = existing || {
      id: orderId,
      intent: "CAPTURE",
      status: "COMPLETED",
      purchase_units: [
        {
          reference_id: `sim-${n}`,
          description: item.title,
          amount: { currency_code: "USD", value: item.amount },
          payee: { email_address: "merchant@example.com", merchant_id: "MERCHANT-MC-1" },
          ...(tracking
            ? { shipping: { trackers: [{ id: `${captureId}-${tracking.number}`, status: "SHIPPED", carrier: tracking.carrier, tracking_number: tracking.number }] } }
            : {}),
          payments: {
            captures: [
              {
                id: captureId,
                status: "COMPLETED",
                amount: { currency_code: "USD", value: item.amount },
                final_capture: true,
                seller_receivable_breakdown: {
                  gross_amount: { currency_code: "USD", value: item.amount },
                  paypal_fee: { currency_code: "USD", value: "0.00" },
                  net_amount: { currency_code: "USD", value: item.amount },
                },
              },
            ],
          },
        },
      ],
      create_time: this.now().toISOString(),
      update_time: this.now().toISOString(),
    };
    mark(job, "order", "done");
    mark(job, "chargeback", "active");
    await wait(instant ? 0 : 250);
    const due = new Date(this.now().getTime() + 10 * 86_400_000).toISOString();
    const requested = reason === "OTHER" ? ["OTHER"] : ["PROOF_OF_FULFILLMENT", "OTHER"];
    const dispute: FixtureDispute = {
      dispute_id: disputeId,
      create_time: this.now().toISOString(),
      update_time: this.now().toISOString(),
      reason,
      status: "WAITING_FOR_SELLER_RESPONSE",
      dispute_state: "REQUIRED_ACTION",
      dispute_amount: { currency_code: "USD", value: item.amount },
      dispute_life_cycle_stage: "CHARGEBACK",
      dispute_channel: "EXTERNAL",
      external_reason_code: code,
      seller_response_due_date: due,
      disputed_transactions: [
        {
          buyer_transaction_id: `MCSIM${n}BUY`,
          seller_transaction_id: captureId,
          create_time: this.now().toISOString(),
          transaction_status: "HELD",
          gross_amount: { currency_code: "USD", value: item.amount },
          buyer: { payer_id: "PAYSIM", name: "Test Buyer" },
          seller: { email: "merchant@example.com", merchant_id: "MERCHANT-MC-1", name: "MendCash Test Store" },
          seller_protection_eligible: false,
        },
      ],
      evidences: [
        {
          evidence_type: "CREATE",
          notes: complaint,
          source: "SUBMITTED_BY_BUYER",
          date: this.now().toISOString(),
          dispute_life_cycle_stage: "CHARGEBACK",
        },
        ...requested.map((type) => ({
          evidence_type: type,
          source: "REQUESTED_FROM_SELLER" as const,
          date: this.now().toISOString(),
          dispute_life_cycle_stage: "CHARGEBACK",
        })),
      ],
      offer: { buyer_requested_amount: { currency_code: "USD", value: item.amount } },
      refund_details: { allowed_refund_amount: { currency_code: "USD", value: item.amount } },
      allowed_response_options: { accept_claim: { accept_claim_types: ["REFUND", "PARTIAL_REFUND"] } },
      links: [
        { href: `https://api-m.sandbox.paypal.com/v1/customer/disputes/${disputeId}`, rel: "self", method: "GET" },
        { href: `https://api-m.sandbox.paypal.com/v1/customer/disputes/${disputeId}/accept-claim`, rel: "accept_claim", method: "POST" },
        { href: `https://api-m.sandbox.paypal.com/v1/customer/disputes/${disputeId}/provide-evidence`, rel: "provide_evidence", method: "POST" },
      ],
      extensions: { mendcash_simulated_deadline: true, mendcash_order_id: orderId },
    };
    this.orders.set(orderId, order);
    this.captureToOrder.set(captureId, orderId);
    this.disputes.set(disputeId, dispute);
    this.createdIds.add(disputeId);
    this.syncMoney(dispute);
    mark(job, "chargeback", "done");
    mark(job, "waiting", "active");
    await wait(instant ? 0 : 400);
    mark(job, "waiting", "done");
    mark(job, "found", "active");
    return disputeId;
  }

  private async liveSimulate(
    job: SimJob,
    item: CatalogItem,
    reasonCode: string,
    complaint: string,
    existing: FixtureOrder | null = null,
  ): Promise<string> {
    mark(job, "order", "active");
    const reference = `mendcash-${Date.now()}`;
    // An agent purchase already has its order; the chargeback goes against that capture.
    const created = existing
      ? existing
      : await this.rest.json(
          "POST",
          "/v2/checkout/orders",
          cardOrderBody({ item, reference, card: this.config.paypal.testCard }),
          { "PayPal-Request-Id": reference, Prefer: "return=representation" },
        );
    const resolved = await orderWithMerchant(this.rest, created, this.config.paypal.merchantId);
    const orderId = stringOf(resolved.order.id);
    const unit = arrayOf(resolved.order.purchase_units)[0];
    const capture = arrayOf(isRecord(unit) ? (unit.payments as { captures?: unknown[] } | undefined)?.captures : undefined)[0];
    const captureId = isRecord(capture) ? stringOf(capture.id) : "";
    if (!orderId || !captureId) {
      throw new Error("PayPal created no capture id on the order. No chargeback was filed.");
    }
    if (!resolved.merchantId) throw new Error(MISSING_MERCHANT_ID);
    const merchantId = resolved.merchantId;
    this.orders.set(orderId, resolved.order as unknown as FixtureOrder);
    this.captureToOrder.set(captureId, orderId);
    const createdRecord = resolved.order;
    mark(job, "order", "done");
    mark(job, "chargeback", "active");
    const now = this.now();
    const responseDate = new Date(now.getTime() + 10 * 86_400_000).toISOString();
    const brand = isRecord(createdRecord.payment_source) && isRecord((createdRecord.payment_source as { card?: unknown }).card)
      ? stringOf(((createdRecord.payment_source as { card: { brand?: string } }).card).brand) || "VISA"
      : "VISA";
    const network = isRecord(capture) && isRecord(capture.network_transaction_reference)
      ? stringOf(capture.network_transaction_reference.id)
      : captureId;
    const chargeback = (await this.rest.json(
      "POST",
      "/v2/customer-support/process-chargeback",
      processChargebackBody({
        merchantId,
        captureId,
        amount: item.amount,
        reasonCode,
        notes: complaint,
        responseDate,
        receiveDate: now.toISOString(),
        cardBrand: brand,
        networkTransactionId: network,
      }),
      { "PayPal-Request-Id": `${reference}-cb` },
    )) as { dispute_id?: string };
    if (!chargeback.dispute_id) throw new Error("Sandbox chargeback did not return a dispute id.");
    this.createdIds.add(chargeback.dispute_id);
    mark(job, "chargeback", "done");
    mark(job, "waiting", "active");
    const deadline = Date.now() + 72_000;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      try {
        const detail = unwrap(await callToolkit(this.config, "get_dispute", { dispute_id: chargeback.dispute_id }));
        if (isRecord(detail) && detail.dispute_id === chargeback.dispute_id) {
          const dispute = detail as unknown as FixtureDispute;
          dispute.extensions = {
            ...(dispute.extensions || { mendcash_simulated_deadline: true, mendcash_order_id: orderId }),
            mendcash_simulated_deadline: true,
            mendcash_order_id: orderId,
          };
          this.remember(dispute);
          mark(job, "waiting", "done");
          mark(job, "found", "active");
          return dispute.dispute_id;
        }
      } catch {
        // PayPal often needs about 40 seconds before the dispute can be read.
      }
    }
    throw new Error(
      `Sandbox dispute ${chargeback.dispute_id} was created but is not readable yet. Refresh the inbox in a minute.`,
    );
  }
}

export type SandboxKind = "require_evidence" | "adjudicate";

type AgentStep = { at: string; step: string; detail: string; state: "done" | "blocked" };

export type AgentPurchaseResult = {
  status: "bought" | "blocked";
  replay: boolean;
  steps: AgentStep[];
  pick: AgentPick & { title: string };
  checks: ConstraintCheck[];
  transactionId: string | null;
  customId: string | null;
  orderId: string | null;
  captureId: string | null;
};

function outcomeOf(dispute: FixtureDispute): string | null {
  return (dispute as FixtureDispute & { dispute_outcome?: { outcome_code?: string } }).dispute_outcome?.outcome_code || null;
}

/** What PayPal's own order record says. custom_id is read from the purchase unit or, failing that, the capture. */
function paypalRecordOf(order: FixtureOrder | null): PayPalRecord {
  const unit = order?.purchase_units?.[0];
  const capture = unit?.payments?.captures?.[0] as (FixtureOrder["purchase_units"][number]["payments"]["captures"][number] & { custom_id?: string }) | undefined;
  const value = capture?.amount?.value;
  return {
    orderId: order?.id || null,
    captureId: capture?.id || null,
    customId: stringOf(unit?.custom_id) || stringOf(capture?.custom_id) || null,
    orderCreateTime: order?.create_time || null,
    captureCents: value && /^\d+(\.\d{1,2})?$/.test(value) ? Math.round(Number(value) * 100) : null,
    currency: capture?.amount?.currency_code || null,
  };
}

function sellerSentEvidence(dispute: FixtureDispute): boolean {
  return (dispute.evidences || []).some((item) => item.source === "SUBMITTED_BY_SELLER" && item.evidence_type !== "CREATE");
}

function awaitingResponse(dispute: FixtureDispute): boolean {
  if (sellerSentEvidence(dispute)) return false;
  return dispute.status === "OPEN" || dispute.status === "WAITING_FOR_SELLER_RESPONSE";
}

function buyerVersion(dispute: FixtureDispute): string {
  return createHash("sha256").update(buyerTextOf(dispute)).digest("hex").slice(0, 16);
}

function stepLabel(id: string, replay: boolean): string {
  if (id === "order") return replay ? "Replay order recorded" : "Placing a sandbox card order";
  if (id === "chargeback") return replay ? "Replay chargeback recorded" : "Raising a sandbox chargeback";
  if (id === "waiting") {
    return replay ? "Skipping the live wait" : "Waiting for PayPal to list the dispute (about 40 seconds)";
  }
  return "Dispute is in the inbox";
}

function mark(job: SimJob, id: string, state: SimStep["state"]): void {
  const step = job.steps.find((row) => row.id === id);
  if (step) step.state = state;
}

function emptyFacts(id: string): MoneyFacts {
  return computeFigures(
    { dispute_id: id, dispute_amount: { currency_code: "USD", value: "0.00" } },
    null,
    new Date(),
    { replay: false },
  );
}

function summaryDispute(row: Record<string, unknown>): FixtureDispute {
  const amount = isRecord(row.dispute_amount) ? row.dispute_amount : {};
  return {
    dispute_id: String(row.dispute_id || ""),
    create_time: String(row.create_time || ""),
    update_time: String(row.update_time || ""),
    reason: String(row.reason || "OTHER"),
    status: String(row.status || "OPEN"),
    dispute_state: String(row.dispute_state || ""),
    dispute_amount: {
      currency_code: typeof amount.currency_code === "string" ? amount.currency_code : "USD",
      value: typeof amount.value === "string" ? amount.value : "0.00",
    },
    dispute_life_cycle_stage: String(row.dispute_life_cycle_stage || ""),
    dispute_channel: String(row.dispute_channel || ""),
    external_reason_code: typeof row.external_reason_code === "string" ? row.external_reason_code : "",
    seller_response_due_date: typeof row.seller_response_due_date === "string" ? row.seller_response_due_date : undefined,
    disputed_transactions: [],
    evidences: [],
    offer: { buyer_requested_amount: { currency_code: "USD", value: "0.00" } },
    refund_details: { allowed_refund_amount: { currency_code: "USD", value: "0.00" } },
    links: Array.isArray(row.links) ? (row.links as FixtureDispute["links"]) : [],
    extensions: { mendcash_simulated_deadline: false, mendcash_order_id: "" },
  };
}

function stringOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function arrayOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

