export type Figure = {
  key: string;
  label: string;
  value: string | null;
  currency: string | null;
  source: string;
  recordId: string;
  recordType: string;
  simulated?: boolean;
};

export type Countdown = {
  deadline: string | null;
  overdue: boolean;
  days: number;
  hours: number;
  minutes: number;
  simulated: boolean;
};

export type DisputeRow = {
  disputeId: string;
  reason: string;
  status: string;
  amount: string | null;
  currency: string;
  deadline: string | null;
  simulatedDeadline: boolean;
  countdown: Countdown;
  snippet: string;
};

export type Session = {
  mode: "live" | "replay";
  replay: boolean;
  modeLabel: string;
  sandbox: boolean;
  invoicingEnabled: boolean;
  recoveredUsd: string;
  atStakeUsd: string;
  caps: { maxDailyUsd: number; analysesPerIp: number; simulationsPerIp: number };
  models: { agent: string; router: string; fallback: string };
  spendTodayUsd: string;
};

export type CaseView = {
  mode: "live" | "replay";
  replay: boolean;
  modeLabel: string;
  dispute: {
    dispute_id: string;
    reason: string;
    status: string;
    dispute_life_cycle_stage?: string;
    external_reason_code?: string;
    seller_response_due_date?: string;
  };
  buyerText: string;
  injection: { detected: boolean; patterns: string[] };
  claimClass: string;
  claimLabel: string;
  draft: { narrative: string; model: string; usageSource: string; label: string } | null;
  capError: string | null;
  plan: {
    requested: string[];
    satisfiable: string[];
    missing: string[];
    tracking: { carrier: string; number: string } | null;
  };
  figures: Figure[];
  countdown: Countdown;
  records: { disputeId: string; captureId: string | null; orderId: string | null; trackerId: string | null };
  timeline: Array<{ id: string; type: string; summary: string; at: string; replay: boolean; verified: boolean }>;
};

export type Payload = {
  action: string;
  method: string;
  path: string;
  contentType: string;
  requestId: string;
  body: unknown;
  summary: string;
};

export type SimJob = {
  id: string;
  status: "running" | "done" | "error";
  steps: Array<{ id: string; label: string; state: string }>;
  disputeId: string | null;
  error: string | null;
  replay: boolean;
  note: string;
};

export type Catalog = {
  items: Array<{ id: string; title: string; amount: string; kind: string }>;
  reasons: Array<{ code: string; reason: string; label: string }>;
};

export type InvoiceView = {
  enabled: boolean;
  note: string;
  invoices: Array<{
    invoice: { id: string; number: string; amount: string; currency: string; dueDate: string; item: string; recipient: string };
    overdueDays: number;
    discountPercent: string;
    discountAmount: string;
  }>;
};

async function parse<T>(response: Response): Promise<T> {
  const body = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
  return body;
}

export const api = {
  session: () => fetch("/api/session").then((r) => parse<Session>(r)),
  disputes: () => fetch("/api/disputes").then((r) => parse<{ disputes: DisputeRow[]; replay: boolean }>(r)),
  case: (id: string) => fetch(`/api/disputes/${id}`).then((r) => parse<CaseView>(r)),
  preview: (id: string, body: Record<string, string>) =>
    fetch(`/api/disputes/${id}/preview`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then((r) => parse<{ payload: Payload }>(r)),
  approve: (id: string, body: Record<string, string>) =>
    fetch(`/api/disputes/${id}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then((r) => parse<{ recoveredUsd?: string; payload: Payload; replay: boolean }>(r)),
  catalog: () => fetch("/api/catalog").then((r) => parse<Catalog>(r)),
  simulate: (body: { itemId: string; reasonCode: string; complaint: string }) =>
    fetch("/api/simulate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then((r) => parse<SimJob>(r)),
  job: (id: string) => fetch(`/api/simulate/${id}`).then((r) => parse<SimJob>(r)),
  invoices: () => fetch("/api/invoices").then((r) => parse<InvoiceView>(r)),
};
