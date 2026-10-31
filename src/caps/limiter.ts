import type { AppConfig } from "../config";
import type { IpCounts, SpendSnapshot } from "./state-file";

export class CapError extends Error {
  readonly status = 429;
}

type Reservation = {
  commit(actualMicro: number): void;
  cancel(): void;
};

export class Limiter {
  private spentMicro = 0;
  private heldMicro = 0;
  private day = "";
  private readonly ips = new Map<string, { day: string; analyses: number; simulations: number; approvals: number }>();
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  private listener: (() => void) | null = null;

  constructor(
    private readonly caps: AppConfig["caps"],
    private readonly now: () => Date = () => new Date(),
  ) {}

  setListener(listener: (() => void) | null): void {
    this.listener = listener;
  }

  get spentUsd(): number {
    this.rollDay();
    return this.spentMicro / 1_000_000;
  }

  /** Restore today's spend and per-IP counts. A previous UTC day is discarded on the next check. */
  hydrate(snapshot: SpendSnapshot): void {
    this.day = snapshot.day;
    this.spentMicro = Math.max(0, Math.round(snapshot.spentMicro) || 0);
    this.heldMicro = 0;
    this.ips.clear();
    for (const [ip, row] of Object.entries(snapshot.ips)) {
      if (ip === "__proto__" || ip === "constructor" || ip === "prototype") continue;
      this.ips.set(ip, { day: snapshot.day, ...row });
    }
    this.rollDay(false);
  }

  exportState(): SpendSnapshot {
    this.rollDay();
    const ips: Record<string, IpCounts> = Object.create(null);
    for (const [ip, row] of this.ips) {
      if (row.day !== this.day) continue;
      ips[ip] = { analyses: row.analyses, simulations: row.simulations, approvals: row.approvals };
    }
    return { day: this.day, spentMicro: this.spentMicro, ips };
  }

  private changed(): void {
    this.listener?.();
  }

  private rollDay(notify = true): void {
    const day = this.now().toISOString().slice(0, 10);
    if (day === this.day) return;
    this.day = day;
    this.spentMicro = 0;
    this.heldMicro = 0;
    this.ips.clear();
    if (notify) this.changed();
  }

  private row(ip: string): { day: string; analyses: number; simulations: number; approvals: number } {
    this.rollDay();
    const day = this.day;
    const existing = this.ips.get(ip);
    if (!existing || existing.day !== day) {
      const fresh = { day, analyses: 0, simulations: 0, approvals: 0 };
      this.ips.set(ip, fresh);
      return fresh;
    }
    return existing;
  }

  reserveAnalysis(ip: string, reserveMicro: number): Reservation {
    const row = this.row(ip);
    if (row.analyses >= this.caps.analysesPerIp) {
      throw new CapError(`This address has used its ${this.caps.analysesPerIp} analyses for today.`);
    }
    const max = Math.round(this.caps.maxDailyUsd * 1_000_000);
    if (this.spentMicro + this.heldMicro + reserveMicro > max) {
      throw new CapError(
        `Daily model cap of ${this.caps.maxDailyUsd.toFixed(2)} USD is reached. Amounts and deadlines are still computed from PayPal records.`,
      );
    }
    row.analyses += 1;
    this.heldMicro += reserveMicro;
    this.changed();
    let settled = false;
    return {
      commit: (actualMicro: number) => {
        if (settled) return;
        settled = true;
        this.heldMicro -= reserveMicro;
        this.spentMicro += Math.max(0, actualMicro);
        this.changed();
      },
      cancel: () => {
        if (settled) return;
        settled = true;
        this.heldMicro -= reserveMicro;
        row.analyses = Math.max(0, row.analyses - 1);
        this.changed();
      },
    };
  }

  takeSimulation(ip: string): void {
    const row = this.row(ip);
    if (row.simulations >= this.caps.simulationsPerIp) {
      throw new CapError(`This address has used its ${this.caps.simulationsPerIp} simulated chargebacks for today.`);
    }
    row.simulations += 1;
    this.changed();
  }

  releaseSimulation(ip: string): void {
    const row = this.ips.get(ip);
    if (!row) return;
    row.simulations = Math.max(0, row.simulations - 1);
    this.changed();
  }

  takeApproval(ip: string): void {
    const row = this.row(ip);
    if (row.approvals >= 40) throw new CapError("This address has used its 40 approvals for today.");
    row.approvals += 1;
    this.changed();
  }

  async withSlot<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.caps.concurrency) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    this.active += 1;
    try {
      return await fn();
    } finally {
      this.active -= 1;
      const next = this.waiters.shift();
      if (next) next();
    }
  }
}
