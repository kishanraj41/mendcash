import fs from "fs";
import path from "path";
import type { ReaderResult } from "../agent/reader";

export type IpCounts = { analyses: number; simulations: number; approvals: number };

export type SpendSnapshot = {
  day: string;
  spentMicro: number;
  ips: Record<string, IpCounts>;
};

export type StoredRead = { version: string; result: ReaderResult };

export type SpendFile = SpendSnapshot & {
  version: 1;
  reads: Record<string, StoredRead>;
};

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const DISPUTE_ID = /^[A-Za-z0-9_-]{4,80}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function count(value: unknown): number {
  const n = typeof value === "number" ? value : Number.NaN;
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(100_000, Math.round(n));
}

function usage(value: unknown): { prompt_tokens: number; completion_tokens: number } | null {
  if (!isRecord(value)) return null;
  const prompt = count(value.prompt_tokens);
  const completion = count(value.completion_tokens);
  if (typeof value.prompt_tokens !== "number" || typeof value.completion_tokens !== "number") return null;
  return { prompt_tokens: prompt, completion_tokens: completion };
}

function storedRead(value: unknown): StoredRead | null {
  if (!isRecord(value) || typeof value.version !== "string" || !value.version) return null;
  const result = value.result;
  if (!isRecord(result)) return null;
  if (result.usageSource !== "model" && result.usageSource !== "recorded") return null;
  if (typeof result.narrative !== "string" || typeof result.model !== "string") return null;
  if (typeof result.claimClass !== "string" || typeof result.buyerText !== "string") return null;
  if (typeof result.latencyMs !== "number" || !Number.isFinite(result.latencyMs)) return null;
  const agentUsage = usage(result.usage);
  const routerUsage = usage(result.routerUsage);
  if (!agentUsage || !routerUsage) return null;
  const injection = isRecord(result.injection) && typeof result.injection.detected === "boolean" ? result.injection : null;
  if (!injection || !Array.isArray(injection.patterns)) return null;
  return { version: value.version, result: result as ReaderResult };
}

export function readSpendFile(file: string): SpendFile | null {
  let raw = "";
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    console.error("MendCash spend file could not be read. Starting today's cap from zero.");
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed) || parsed.version !== 1) return null;
    if (typeof parsed.day !== "string" || !DAY.test(parsed.day)) return null;
    const spent = typeof parsed.spentMicro === "number" ? parsed.spentMicro : Number.NaN;
    if (!Number.isFinite(spent) || spent < 0 || spent > 100_000_000) return null;
    const ips: Record<string, IpCounts> = Object.create(null);
    if (isRecord(parsed.ips)) {
      for (const [ip, row] of Object.entries(parsed.ips)) {
        if (ip === "__proto__" || ip === "constructor" || ip === "prototype") continue;
        if (!isRecord(row)) continue;
        ips[ip] = { analyses: count(row.analyses), simulations: count(row.simulations), approvals: count(row.approvals) };
      }
    }
    const reads: Record<string, StoredRead> = Object.create(null);
    if (isRecord(parsed.reads)) {
      for (const [id, row] of Object.entries(parsed.reads)) {
        if (!DISPUTE_ID.test(id)) continue;
        const stored = storedRead(row);
        if (stored) reads[id] = stored;
      }
    }
    return { version: 1, day: parsed.day, spentMicro: Math.round(spent), ips, reads };
  } catch {
    console.error("MendCash spend file was not valid JSON. Starting today's cap from zero.");
    return null;
  }
}

export function writeSpendFile(file: string, data: SpendFile): void {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
  fs.renameSync(tmp, file);
}
