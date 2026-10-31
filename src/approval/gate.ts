import type { PreparedAction } from "./payload";
import { partialRefundCents, type MoneyFacts } from "../money/engine";
import { moneyToCents } from "../money/format";

export type WriteCall = {
  action: string;
  method: "POST";
  path: string;
  contentType: string;
  requestId: string;
  body: Record<string, unknown>;
  disputeId: string;
};

export type WritePort = {
  perform(call: WriteCall): Promise<{ status: number; body: unknown }>;
};

export type ApprovalRecord = {
  id: string;
  disputeId: string;
  prepared: PreparedAction;
  createdAt: string;
  executedAt: string | null;
  result: { status: number; body: unknown } | null;
};

export class ApprovalGate {
  private seq = 0;
  private readonly pending = new Map<string, ApprovalRecord>();
  private readonly byRequest = new Map<string, ApprovalRecord>();
  readonly calls: WriteCall[] = [];
  private sessionRefundCents = 0;
  private stagedRefundCents = 0;

  constructor(
    private readonly port: WritePort,
    private readonly caps: { maxSessionRefundUsd: number; maxPartialRefundUsd: number },
  ) {}

  stage(disputeId: string, prepared: PreparedAction, now: Date): ApprovalRecord {
    const existing = this.byRequest.get(prepared.requestId);
    if (existing) return existing;
    this.seq += 1;
    const record: ApprovalRecord = {
      id: `apr-${this.seq}`,
      disputeId,
      prepared,
      createdAt: now.toISOString(),
      executedAt: null,
      result: null,
    };
    this.pending.set(record.id, record);
    this.byRequest.set(prepared.requestId, record);
    return record;
  }

  list(disputeId?: string): ApprovalRecord[] {
    return [...this.pending.values()].filter((r) => !disputeId || r.disputeId === disputeId);
  }

  async approve(id: string, now: Date, facts: MoneyFacts): Promise<ApprovalRecord> {
    const record = this.pending.get(id);
    if (!record) throw new Error("Unknown approval. Stage the payload first. Nothing was sent.");
    if (record.result) return record;
    this.stagedRefundCents = this.refundCents(record.prepared, facts);
    const call: WriteCall = {
      action: record.prepared.action,
      method: record.prepared.method,
      path: record.prepared.path,
      contentType: record.prepared.contentType,
      requestId: record.prepared.requestId,
      body: record.prepared.body,
      disputeId: record.disputeId,
    };
    if (call.path.includes("?") || call.path.includes("%3F")) {
      throw new Error("Refusing a write whose path contains a query string.");
    }
    const result = await this.port.perform(call);
    this.calls.push(call);
    record.executedAt = now.toISOString();
    record.result = result;
    this.sessionRefundCents += this.stagedRefundCents;
    this.stagedRefundCents = 0;
    return record;
  }

  private refundCents(prepared: PreparedAction, facts: MoneyFacts): number {
    if (prepared.action !== "partial_refund" && prepared.action !== "accept_claim") return 0;
    const cap = moneyToCents(this.caps.maxSessionRefundUsd.toFixed(2));
    let next = 0;
    if (prepared.action === "accept_claim") {
      next = facts.stakeCents || 0;
    } else {
      const amount = (prepared.body.refund_amount as { value?: string } | undefined)?.value;
      if (!amount) throw new Error("Partial refund payload is missing refund_amount.");
      next = partialRefundCents(amount, facts, this.caps).cents;
    }
    if (this.sessionRefundCents + next > cap) {
      throw new Error("That refund would pass the session refund cap. Nothing was sent.");
    }
    return next;
  }
}
