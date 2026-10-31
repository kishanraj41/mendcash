import { createHash, randomUUID } from "crypto";
import { classifyClaim, claimLabel } from "../agent/classify";
import { buyerTextOf, planEvidence, refundIdOf } from "../agent/evidence";
import { stripModelMoney } from "../agent/injection";
import { createNebiusClient } from "../agent/llm";
import { readWithModel, readWithRules, type ReaderInput, type ReaderResult } from "../agent/reader";
import { prepareAction, type ActionName, type PreparedAction } from "../approval/payload";
import { ApprovalGate, type WriteCall, type WritePort } from "../approval/gate";
import { Limiter } from "../caps/limiter";
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
  private lastBulkRefresh = 0;
  private readonly failedAt = new Map<string, number>();
  private readonly jobs = new Map<string, SimJob & { done: Promise<void> }>();
  private readonly timeline: TimelineEvent[] = [];
  private readonly fetchedAt = new Map<string, number>();
  private readonly createdIds = new Set<string>();
  private readonly submitted = new Map<string, number>();
  private readonly recovered = new Map<string, number>();
  private filling = false;
  private simSeq = 0;
  private readonly reader: (input: ReaderInput) => Promise<ReaderResult>;
  private readonly port: WritePort;
  readonly writes: WriteCall[] = [];

  constructor(
    private readonly config: AppConfig,
    private readonly now: () => Date = () => new Date(),
    reader?: (input: ReaderInput) => Promise<ReaderResult>,
    private readonly rest: PayPalRest = new PayPalRest({ config, now }),
  ) {
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
    const sent = (dispute.evidences || []).some((item) => item.source === "SUBMITTED_BY_SELLER" && item.evidence_type !== "CREATE");
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
    const disputes = await this.allDisputes();
    return disputes.map((dispute) => {
      const order = this.orderSync(dispute);
      const facts = computeFigures(dispute, order, this.now(), { replay: this.config.mode === "replay" });
      const text = buyerTextOf(dispute);
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
        snippet: text.slice(0, 110),
        claimLabel: claimLabel(classifyClaim(dispute.reason, text, null)),
        updated: dispute.update_time,
      };
    });
  }

  async atStakeUsd(): Promise<string> {
    let cents = 0;
    for (const dispute of this.disputes.values()) {
      if (!this.createdIds.has(dispute.dispute_id) || dispute.status === "RESOLVED") continue;
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
    const version = buyerVersion(dispute);
    const cached = this.reads.get(dispute.dispute_id);
    const cacheHit = cached?.version === version ? cached.result : null;
    let draft: ReaderResult | null = cacheHit ?? (analyze === false ? cached?.result ?? null : null);
    let capError: string | null = null;
    const wantModel = !cacheHit && analyze !== false && (analyze === true || (analyze === "auto" && member));
    if (wantModel && !cacheHit) {
      try {
        draft = await this.analyze(dispute, ip);
      } catch (error) {
        capError = error instanceof Error ? error.message : "Analysis failed.";
        if (!draft) draft = readWithRules(dispute);
      }
    } else if (!draft) {
      draft = readWithRules(dispute);
    }
    const narrative = draft ? stripModelMoney(draft.narrative) : "";
    const claimClass = draft
      ? classifyClaim(dispute.reason, draft.buyerText, draft.claimClass)
      : classifyClaim(dispute.reason, buyerTextOf(dispute), null);
    return {
      mode: this.config.mode,
      replay: this.config.mode === "replay",
      modeLabel: this.modeLabel(),
      dispute,
      order,
      buyerText: buyerTextOf(dispute),
      injection: draft?.injection || { detected: false, patterns: [] },
      claimClass,
      claimLabel: claimLabel(claimClass),
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
    try {
      return { payload: this.build(dispute, action, fields) };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Preview failed.";
      if (/not asking/i.test(message)) return { waiting: true, message };
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
    const prepared = this.build(dispute, action, fields);
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

  simulate(input: { itemId: string; reasonCode: string; complaint: string }, ip: string, instant: boolean): {
    job: SimJob;
    done: Promise<void>;
  } {
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
          ? await this.replaySimulate(job, item, reason.reason, reason.code, complaint, instant)
          : await this.liveSimulate(job, item, reason.code, complaint);
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
    };
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
      reservation.commit(micro);
      const reconciled = classifyClaim(dispute.reason, result.buyerText, result.claimClass);
      const stored = { ...result, claimClass: reconciled, claimLabel: claimLabel(reconciled), narrative: stripModelMoney(result.narrative) };
      this.reads.set(dispute.dispute_id, { version: buyerVersion(dispute), result: stored });
      return stored;
    } catch (error) {
      reservation.cancel();
      throw error;
    }
  }

  private build(
    dispute: FixtureDispute,
    action: ActionName,
    fields: { partialAmount?: string; carrier?: string; trackingNumber?: string },
  ): PreparedAction {
    const order = this.orderSync(dispute);
    const facts = computeFigures(dispute, order, this.now(), { replay: this.config.mode === "replay" });
    const plan = planEvidence(dispute, order, refundIdOf(order, dispute));
    const draft = this.reads.get(dispute.dispute_id)?.result;
    const narrative = stripModelMoney(draft?.narrative || readWithRules(dispute).narrative);
    const claimClass = classifyClaim(dispute.reason, buyerTextOf(dispute), draft?.claimClass || null);
    return prepareAction({
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
    if (missing.length) void this.fillMissing(missing);
    else if (stale.length && this.now().getTime() - this.lastBulkRefresh > 45_000) {
      this.lastBulkRefresh = this.now().getTime();
      void this.fillMissing(stale.slice(0, 8));
    }
    return rows;
  }

  private listFresh(id: string): boolean {
    const at = this.fetchedAt.get(id);
    if (at === undefined || !this.disputes.has(id)) return false;
    return this.now().getTime() - at < 60_000;
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

  private async fillMissing(ids: string[]): Promise<void> {
    if (this.filling) return;
    this.filling = true;
    const queue = [...ids];
    try {
      const workers = Array.from({ length: Math.min(5, queue.length) }, async () => {
        while (queue.length) {
          const id = queue.shift();
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
      });
      await Promise.all(workers);
    } finally {
      this.filling = false;
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
        });
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
      const body = await this.rest.multipart(call.path, call.body, call.requestId);
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
  ): Promise<string> {
    const wait = async (ms: number) => {
      if (!instant && ms) await new Promise((resolve) => setTimeout(resolve, ms));
    };
    mark(job, "order", "active");
    await wait(instant ? 0 : 250);
    this.simSeq += 1;
    const n = String(this.simSeq).padStart(4, "0");
    const orderId = `MCSIM${n}ORD`;
    const captureId = `MCSIM${n}CAP`;
    const disputeId = `PP-R-SIM-${n}`;
    const tracking = item.kind === "physical" ? { carrier: "UPS", number: `1ZMCRPLY${n}` } : null;
    const order: FixtureOrder = {
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

  private async liveSimulate(job: SimJob, item: CatalogItem, reasonCode: string, complaint: string): Promise<string> {
    mark(job, "order", "active");
    const reference = `mendcash-${Date.now()}`;
    const created = await this.rest.json(
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

