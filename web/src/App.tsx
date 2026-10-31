import { useEffect, useMemo, useRef, useState } from "react";
import { api, type CaseView, type Catalog, type DisputeRow, type InvoiceView, type Payload, type Session, type SimJob } from "./api";

type Action = "provide_evidence" | "add_tracking" | "accept_claim" | "partial_refund";

const ACTIONS: Array<{ id: Action; label: string }> = [
  { id: "provide_evidence", label: "Send evidence" },
  { id: "add_tracking", label: "Add tracking" },
  { id: "accept_claim", label: "Accept claim" },
  { id: "partial_refund", label: "Partial refund" },
];

export function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [rows, setRows] = useState<DisputeRow[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [caseView, setCaseView] = useState<CaseView | null>(null);
  const [invoices, setInvoices] = useState<InvoiceView | null>(null);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [simulateOpen, setSimulateOpen] = useState(false);
  const [loadingCase, setLoadingCase] = useState(false);

  async function refreshLists() {
    const [nextSession, list, invoiceView, nextCatalog] = await Promise.all([
      api.session(),
      api.disputes(),
      api.invoices(),
      api.catalog(),
    ]);
    setSession(nextSession);
    setRows(list.disputes);
    setInvoices(invoiceView);
    setCatalog(nextCatalog);
  }

  useEffect(() => {
    refreshLists().catch((err: Error) => setError(err.message));
    const timer = window.setInterval(() => {
      refreshLists().catch(() => undefined);
    }, 12000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!selected) {
      setCaseView(null);
      return;
    }
    let cancel = false;
    setCaseView(null);
    setLoadingCase(true);
    api.case(selected)
      .then((view) => {
        if (!cancel) setCaseView(view);
        api.session().then((next) => {
          if (!cancel) setSession(next);
        }).catch(() => undefined);
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => {
        if (!cancel) setLoadingCase(false);
      });
    const timer = window.setInterval(() => {
      api.case(selected, false)
        .then((view) => {
          if (!cancel) setCaseView(view);
        })
        .catch(() => undefined);
    }, 8000);
    return () => {
      cancel = true;
      window.clearInterval(timer);
    };
  }, [selected]);

  return (
    <div className="app">
      <header className="top">
        <div>
          <p className="kicker">PayPal dispute desk</p>
          <h1>MendCash</h1>
          <p className="tag">AI reads the messy text. Code does the math. You approve.</p>
        </div>
        <div className="top-actions">
          <div className="stake">
            <span>Submitted</span>
            <strong>${session?.submittedUsd ?? "—"}</strong>
            <small>this demo, evidence sent</small>
          </div>
          <div className="recovered">
            <span>Recovered</span>
            <strong>${session?.recoveredUsd ?? "—"}</strong>
            <small>resolved for the seller</small>
          </div>
          <div className="stake">
            <span>Open stake</span>
            <strong>${session?.atStakeUsd ?? "—"}</strong>
            <small>this demo, still open</small>
          </div>
          <button className="primary" type="button" onClick={() => setSimulateOpen(true)}>
            Simulate a chargeback
          </button>
        </div>
      </header>
      {session && (
        <div className="banner">
          {session.modeLabel} Daily model cap ${session.caps.maxDailyUsd.toFixed(2)}. Spent today ${session.spendTodayUsd}.
          {session.mode === "live" && !session.webhooksConfigured ? " Webhooks are off, so status refreshes by polling." : ""}
        </div>
      )}
      {error && <p className="error" style={{ margin: 12 }}>{error}</p>}
      <div className="shell">
        <aside className="inbox">
          <div className="inbox-head">
            <h2>Inbox</h2>
            <span className="meta">{rows.length}</span>
          </div>
          <div className="rows">
            {rows.map((row) => (
              <button key={row.disputeId} className={row.disputeId === selected ? "row active" : "row"} type="button" onClick={() => setSelected(row.disputeId)}>
                <span>{row.claimLabel || prettyReason(row.reason)}</span>
                <span className="amt">${row.amount ?? "—"}</span>
                <span className="snip">{row.snippet || "No buyer text"}</span>
                <span className="meta">{row.status.replaceAll("_", " ")} · {countdownText(row.countdown)}</span>
              </button>
            ))}
          </div>
          <InvoicePanel invoices={invoices} onApproved={() => refreshLists().catch((err: Error) => setError(err.message))} />
        </aside>
        <main className="case">
          {!selected && (
            <div className="welcome">
              <h2>A chargeback is a deadline with a story attached.</h2>
              <p>Open one from the inbox, or simulate a sandbox chargeback with your own complaint. No login. The model never sets the amount or the deadline, and nothing is sent to PayPal until you approve the payload.</p>
            </div>
          )}
          {selected && loadingCase && <p className="meta">Reading the dispute…</p>}
          {caseView && <CasePane view={caseView} onChanged={() => { refreshLists().catch((err: Error) => setError(err.message)); api.case(caseView.dispute.dispute_id).then(setCaseView).catch((err: Error) => setError(err.message)); }} />}
        </main>
      </div>
      {simulateOpen && catalog && (
        <Simulate
          catalog={catalog}
          replay={Boolean(session?.replay)}
          onClose={() => setSimulateOpen(false)}
          onFound={(id) => {
            setSimulateOpen(false);
            setSelected(id);
            refreshLists().catch((err: Error) => setError(err.message));
          }}
        />
      )}
    </div>
  );
}

function CasePane({ view, onChanged }: { view: CaseView; onChanged: () => void }) {
  const [action, setAction] = useState<Action>("provide_evidence");
  const [partial, setPartial] = useState("10.00");
  const [carrier, setCarrier] = useState(view.plan.tracking?.carrier || "UPS");
  const [tracking, setTracking] = useState(view.plan.tracking?.number || "");
  const [payload, setPayload] = useState<Payload | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [readOnly, setReadOnly] = useState<string | null>(null);
  const [waiting, setWaiting] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [sentAction, setSentAction] = useState<Action | null>(null);
  const [busy, setBusy] = useState(false);
  const stakeFigure = view.figures.find((figure) => figure.key === "stake");

  useEffect(() => {
    setCarrier(view.plan.tracking?.carrier || "UPS");
    setTracking(view.plan.tracking?.number || "");
    setResult(null);
    setSentAction(null);
  }, [view.dispute.dispute_id, view.plan.tracking?.carrier, view.plan.tracking?.number]);

  const body = useMemo(() => {
    const fields: Record<string, string> = { action };
    if (action === "partial_refund") fields.partialAmount = partial;
    if (action === "add_tracking") {
      if (carrier) fields.carrier = carrier;
      if (tracking) fields.trackingNumber = tracking;
    }
    return fields;
  }, [action, partial, carrier, tracking]);

  useEffect(() => {
    let cancel = false;
    api.preview(view.dispute.dispute_id, body)
      .then((res) => {
        if (cancel) return;
        if (res.readOnly) {
          setPayload(null);
          setReadOnly(res.message || "Read only. This dispute was not created in this demo.");
          setWaiting(false);
          setPreviewError(null);
          return;
        }
        setReadOnly(null);
        if (res.waiting || !res.payload) {
          setPayload(null);
          setWaiting(true);
          setPreviewError(null);
          return;
        }
        setPayload(res.payload);
        setWaiting(false);
        setPreviewError(null);
      })
      .catch((err: Error) => {
        if (!cancel) {
          setPayload(null);
          setWaiting(false);
          setReadOnly(null);
          setPreviewError(err.message);
        }
      });
    return () => {
      cancel = true;
    };
  }, [view.dispute.dispute_id, view.dispute.status, view.dispute.update_time, body]);

  async function approve() {
    setBusy(true);
    setResult(null);
    try {
      const approved = await api.approve(view.dispute.dispute_id, body);
      setSentAction(action);
      setResult(approved.replay ? "Approved in replay. PayPal was not called." : "Approved and sent to the PayPal sandbox.");
      onChanged();
    } catch (err) {
      setPreviewError(err instanceof Error ? err.message : "Approve failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="case-head">
        <div>
          <h2>{view.claimLabel}</h2>
          <p className="meta">{view.dispute.dispute_id} · {view.dispute.status.replaceAll("_", " ")}</p>
        </div>
      </div>
      <div className="chips">
        <span className="chip">{view.dispute.reason.replaceAll("_", " ")}</span>
        {view.dispute.external_reason_code && <span className="chip">code {view.dispute.external_reason_code}</span>}
        {view.countdown.simulated && <span className="chip warn">Simulated deadline</span>}
        {view.injection.detected && <span className="chip bad">Buyer instructions ignored</span>}
        {view.replay && <span className="chip warn">Replay</span>}
      </div>
      <div className="figures">
        {view.figures.filter((figure) => figure.key !== "deadline").map((figure) => (
          <div className="figure" key={figure.key}>
            <div className="label">{figure.label}</div>
            <div className="value">{figure.value ? (figure.currency ? `$${figure.value}` : figure.value) : "—"}</div>
            <div className="src">{softWrap(figure.source)}</div>
            <div className="src">{softWrap(figure.recordId)}</div>
          </div>
        ))}
        <div className="figure">
          <div className="label">{view.countdown.simulated ? "Simulated deadline" : "Response deadline"}</div>
          <div className="value" style={{ fontSize: 22 }}>{countdownText(view.countdown)}</div>
          <div className="src">seller_response_due_date · {view.records.disputeId}</div>
        </div>
      </div>
      <div className="split">
        <section className="panel">
          <h3>What the buyer wrote</h3>
          <div className="buyer">{view.buyerText || "No buyer text on this dispute."}</div>
          {view.capError && <p className="error">{view.capError} The figures above still come from PayPal records.</p>}
          {view.draft && (
            <>
              <h3>Draft</h3>
              <p className="meta">{view.draft.label}</p>
              {view.draft.costUsd && (
                <p className="meta">This read cost ${view.draft.costUsd} and took {(view.draft.latencyMs / 1000).toFixed(1)} s.</p>
              )}
              <p className="draft">{view.draft.narrative}</p>
            </>
          )}
          <p className="meta" style={{ marginTop: 12 }}>
            Evidence PayPal asked for: {view.plan.requested.length ? view.plan.requested.join(", ") : view.dispute.status === "UNDER_REVIEW" ? "none — PayPal is reviewing what was sent" : "none yet"}.
            Ready to send: {view.plan.satisfiable.join(", ") || "notes only"}.
            Missing: {view.plan.missing.join(", ") || "nothing"}.
          </p>
          <p className="meta">Amount at stake is {stakeFigure?.value ?? "—"} from {stakeFigure?.source}.</p>
          {view.timeline.length > 0 && (
            <div className="timeline">
              <h3>Timeline</h3>
              <ul>
                {view.timeline.map((event) => (
                  <li key={event.id}>{event.type}: {event.summary} {event.replay ? "(replay)" : event.verified ? "(signature verified)" : ""}</li>
                ))}
              </ul>
            </div>
          )}
        </section>
        <aside className="panel">
          <h3>Approval</h3>
          <p className="meta">This is the request that will be sent. Nothing goes out until you approve it.</p>
          <div className="tabs">
            {ACTIONS.map((item) => (
              <button key={item.id} type="button" aria-pressed={action === item.id} onClick={() => setAction(item.id)}>
                {item.label}
              </button>
            ))}
          </div>
          {action === "partial_refund" && (
            <label className="field">
              Partial amount (USD). Capped at $200 and must be under the dispute amount. PayPal must list PARTIAL_REFUND or nothing is sent.
              <input value={partial} onChange={(event) => setPartial(event.target.value)} inputMode="decimal" />
            </label>
          )}
          {action === "add_tracking" && (
            <>
              <label className="field">
                Carrier
                <select value={carrier} onChange={(event) => setCarrier(event.target.value)}>
                  {["UPS", "USPS", "FEDEX", "DHL", "OTHER"].map((name) => <option key={name}>{name}</option>)}
                </select>
              </label>
              <label className="field">
                Tracking number
                <input value={tracking} onChange={(event) => setTracking(event.target.value)} placeholder="From the shipment, not the buyer message" />
              </label>
            </>
          )}
          {sentAction ? (
            <p className="meta">Evidence sent. PayPal is reviewing.</p>
          ) : readOnly ? (
            <p className="meta">{readOnly}</p>
          ) : waiting && canBecomeActionable(view.dispute.external_reason_code, view.replay) ? (
            <p className="meta">Waiting for PayPal to ask for evidence. In the sandbox this usually takes about 4 minutes after a simulated chargeback.</p>
          ) : waiting ? (
            <p className="meta">PayPal has not asked for evidence on this dispute. In the sandbox, only reason code 4853 usually becomes actionable.</p>
          ) : previewError ? (
            <p className="error">{previewError}</p>
          ) : null}
          {payload && (
            <>
              <p className="path">{payload.method} {payload.path}</p>
              <p className="path">{payload.contentType} · PayPal-Request-Id {payload.requestId}</p>
              <pre className="code">{JSON.stringify(payload.body, null, 2)}</pre>
            </>
          )}
          {result && <p className="okmsg">{result}</p>}
          <button className={action === "accept_claim" || action === "partial_refund" ? "danger" : "primary"} type="button" disabled={!payload || busy || sentAction === action || Boolean(readOnly)} onClick={() => approve().catch(() => undefined)}>
            {busy ? "Sending…" : "Approve and send"}
          </button>
        </aside>
      </div>
    </div>
  );
}

function Simulate({ catalog, replay, onClose, onFound }: { catalog: Catalog; replay: boolean; onClose: () => void; onFound: (id: string) => void }) {
  const [itemId, setItemId] = useState(catalog.items[0]?.id || "");
  const [reasonCode, setReasonCode] = useState(catalog.reasons[0]?.code || "4853");
  const [complaint, setComplaint] = useState("");
  const [job, setJob] = useState<SimJob | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reported = useRef(false);
  useEffect(() => {
    if (!job || job.status !== "running") return;
    const timer = setInterval(() => {
      api.job(job.id).then((next) => {
        setJob(next);
        if (next.status === "done" && next.disputeId && !reported.current) {
          reported.current = true;
          onFound(next.disputeId);
        }
      }).catch((err: Error) => setError(err.message));
    }, 800);
    return () => clearInterval(timer);
  }, [job, onFound]);

  async function start() {
    setError(null);
    try {
      const created = await api.simulate({ itemId, reasonCode, complaint });
      setJob(created);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start");
    }
  }

  return (
    <div className="overlay" role="presentation" onClick={onClose}>
      <div className="panel dialog" role="dialog" aria-labelledby="sim-title" onClick={(event) => event.stopPropagation()}>
        <div className="dialog-head">
          <h3 id="sim-title">Simulate a chargeback</h3>
          <button className="ghost" type="button" onClick={onClose}>Close</button>
        </div>
        <p className="meta">
          {replay
            ? "Replay. This does not call PayPal. A live sandbox chargeback usually takes about 40 seconds, then a few more minutes before 4853 becomes actionable."
            : "Sandbox simulation. MendCash places a card order, then raises a chargeback. New disputes take about 40 seconds to appear. Use reason code 4853 if you want to answer it: other codes often stay under review in the sandbox. The deadline shown is PayPal's seller_response_due_date once it exists."}
        </p>
        <label className="field">
          Item
          <select value={itemId} onChange={(event) => setItemId(event.target.value)}>
            {catalog.items.map((item) => <option key={item.id} value={item.id}>{item.title} · ${item.amount}</option>)}
          </select>
        </label>
        <label className="field">
          Reason code
          <select value={reasonCode} onChange={(event) => setReasonCode(event.target.value)}>
            {catalog.reasons.map((reason) => (
              <option key={reason.code} value={reason.code}>
                {reason.code} · {reason.label}{reason.sandboxActionable ? "" : " · sandbox often stays under review"}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          Buyer complaint
          <textarea rows={4} value={complaint} onChange={(event) => setComplaint(event.target.value)} placeholder="The files never arrived, and the download link is dead." />
        </label>
        {error && <p className="error">{error}</p>}
        <button className="primary" type="button" disabled={complaint.trim().length < 3 || job?.status === "running"} onClick={() => start().catch(() => undefined)}>
          {job?.status === "running" ? "Working…" : "Create the chargeback"}
        </button>
        {job && (
          <>
            <p className="meta" style={{ marginTop: 10 }}>{job.note}</p>
            <ul className="steps">
              {job.steps.map((step) => <li key={step.id} className={step.state}>{step.label}</li>)}
            </ul>
            {job.error && <p className="error">{job.error}</p>}
          </>
        )}
      </div>
    </div>
  );
}

function InvoicePanel({ invoices, onApproved }: { invoices: InvoiceView | null; onApproved: () => void }) {
  const [message, setMessage] = useState<string | null>(null);
  if (!invoices) return null;
  return (
    <div style={{ padding: 14, borderTop: "1px solid var(--line)" }}>
      <h2 style={{ fontSize: 18 }}>Invoices</h2>
      <p className="meta">{invoices.note}</p>
      {invoices.enabled && invoices.invoices.map((row) => (
        <div key={row.invoice.id} style={{ marginTop: 8 }}>
          <p>{row.invoice.item} · ${row.invoice.amount} · due {row.invoice.dueDate}</p>
          <p className="meta">{row.overdueDays} days overdue · 5% discount is ${row.discountAmount}, from the invoice amount.</p>
          <button className="ghost" type="button" onClick={() => approveInvoice(row.invoice.id, "send_invoice_reminder", setMessage, onApproved)}>Send reminder</button>
          <button className="ghost" type="button" onClick={() => approveInvoice(row.invoice.id, "create_early_payment_discount", setMessage, onApproved)}>Add 5% discount</button>
        </div>
      ))}
      {message && <p className="okmsg">{message}</p>}
    </div>
  );
}

async function approveInvoice(id: string, action: string, setMessage: (value: string) => void, onApproved: () => void) {
  try {
    const result = await api.approve(id, { action });
    setMessage(result.replay ? "Approved in replay. PayPal was not called." : "Approved.");
    onApproved();
  } catch (error) {
    setMessage(error instanceof Error ? error.message : "Could not approve");
  }
}

function softWrap(value: string) {
  return value.split(/([._])/).map((part, index) =>
    part === "." || part === "_" ? <span key={index}>{part}<wbr /></span> : <span key={index}>{part}</span>,
  );
}

function canBecomeActionable(reasonCode: string | undefined, replay: boolean): boolean {
  return replay || reasonCode === "4853";
}

function prettyReason(reason: string): string {
  return reason.replaceAll("_", " ").toLowerCase().replace(/^\w/, (c) => c.toUpperCase());
}

function countdownText(countdown: { deadline: string | null; overdue: boolean; days: number; hours: number; minutes: number }): string {
  if (!countdown.deadline) return "No deadline yet";
  const prefix = countdown.overdue ? "Overdue" : "Due in";
  return `${prefix} ${countdown.days}d ${countdown.hours}h`;
}
