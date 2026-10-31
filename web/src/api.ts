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
  claimLabel?: string;
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
  webhooksConfigured: boolean;
  recoveredUsd: string;
  submittedUsd: string;
  csrfToken: string;
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
  draft: { narrative: string; model: string; usageSource: string; label: string; costUsd: string | null; latencyMs: number } | null;
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
  reasons: Array<{ code: string; reason: string; label: string; sandboxActionable?: boolean }>;
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

let csrfToken = "";

async function parse<T>(response: Response): Promise<T> {
  const body = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
  return body;
}

async function token(): Promise<string> {
  if (csrfToken) return csrfToken;
  const session = await api.session();
  csrfToken = session.csrfToken;
  return csrfToken;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const csrf = await token();
  const response = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", "x-mendcash-csrf": csrf },
    body: JSON.stringify(body),
  });
  return parse<T>(response);
}

export const api = {
  session: async () => {
    const session = await parse<Session>(await fetch("/api/session", { credentials: "same-origin" }));
    if (session.csrfToken) csrfToken = session.csrfToken;
    return session;
  },
  disputes: () => fetch("/api/disputes").then((r) => parse<{ disputes: DisputeRow[]; replay: boolean }>(r)),
  case: (id: string, analyze = true) =>
    fetch(`/api/disputes/${id}${analyze ? "" : "?analyze=0"}`).then((r) => parse<CaseView>(r)),
  preview: (id: string, body: Record<string, string>) => post<{ payload: Payload }>(`/api/disputes/${id}/preview`, body),
  approve: (id: string, body: Record<string, string>) =>
    post<{ recoveredUsd?: string; submittedUsd?: string; payload: Payload; replay: boolean }>(`/api/disputes/${id}/approve`, body),
  catalog: () => fetch("/api/catalog").then((r) => parse<Catalog>(r)),
  simulate: (body: { itemId: string; reasonCode: string; complaint: string }) => post<SimJob>("/api/simulate", body),
  job: (id: string) => fetch(`/api/simulate/${id}`).then((r) => parse<SimJob>(r)),
  invoices: () => fetch("/api/invoices").then((r) => parse<InvoiceView>(r)),
};
