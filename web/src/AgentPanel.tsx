import { useEffect, useRef, useState } from "react";
import { api, type AgentProof, type AgentPurchaseResult, type Catalog, type Recommendation, type SandboxOptions, type SimJob } from "./api";

const DEFAULT_COMPLAINT = "I never agreed to this purchase. My AI shopping assistant bought it on its own.";

const PRESETS = [
  { label: "Within the mandate", instruction: "Get me something to decorate my laptop, under $20.", allowed: ["stickers", "poster"], maxUsd: "20" },
  { label: "Agent overreaches", instruction: "Buy the brand kit for the launch.", allowed: ["stickers", "logo-pack"], maxUsd: "75" },
];

/** The buyer grants a mandate, the agent shops, code checks the pick, then PayPal gets an order with custom_id. */
export function AgentPurchase({ catalog, replay, onClose, onFound }: { catalog: Catalog; replay: boolean; onClose: () => void; onFound: (id: string) => void }) {
  const [instruction, setInstruction] = useState(PRESETS[0].instruction);
  const [allowed, setAllowed] = useState<string[]>(PRESETS[0].allowed);
  const [maxUsd, setMaxUsd] = useState(PRESETS[0].maxUsd);
  const [result, setResult] = useState<AgentPurchaseResult | null>(null);
  const [complaint, setComplaint] = useState(DEFAULT_COMPLAINT);
  const [job, setJob] = useState<SimJob | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const first = useRef<HTMLTextAreaElement>(null);
  const reported = useRef(false);

  useEffect(() => {
    first.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

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

  function preset(index: number) {
    const row = PRESETS[index];
    setInstruction(row.instruction);
    setAllowed(row.allowed);
    setMaxUsd(row.maxUsd);
    setResult(null);
    setJob(null);
  }

  async function buy() {
    setBusy(true);
    setError(null);
    setJob(null);
    try {
      setResult(await api.agentPurchase({ instruction, allowedIds: allowed, maxUsd }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "The agent could not run.");
    } finally {
      setBusy(false);
    }
  }

  async function dispute() {
    if (!result?.transactionId) return;
    setError(null);
    try {
      const created = await api.disputeAgentPurchase(result.transactionId, complaint);
      reported.current = false;
      setJob(created);
      if (created.status === "done" && created.disputeId) onFound(created.disputeId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not file the chargeback.");
    }
  }

  return (
    <div className="overlay" role="presentation" onClick={onClose}>
      <div className="panel dialog wide" role="dialog" aria-modal="true" aria-labelledby="agent-title" onClick={(event) => event.stopPropagation()}>
        <div className="dialog-head">
          <h3 id="agent-title">Let an AI agent buy</h3>
          <button className="ghost" type="button" onClick={onClose}>Close</button>
        </div>
        <p className="meta">
          The buyer signs a mandate. The shopping agent picks an item. Code checks the pick against the signed mandate before anything is paid.
          {replay ? " Replay: no PayPal call." : " Sandbox: a real PayPal order is created with custom_id = ap2:<transaction_id>."}
        </p>
        <div className="preset-row" role="group" aria-label="Examples">
          {PRESETS.map((row, index) => (
            <button key={row.label} className="ghost" type="button" onClick={() => preset(index)}>{row.label}</button>
          ))}
        </div>
        <label className="field">
          What the buyer tells the agent
          <textarea ref={first} rows={2} value={instruction} onChange={(event) => setInstruction(event.target.value)} />
        </label>
        <fieldset className="field">
          <legend>Items the buyer allows</legend>
          {catalog.items.map((item) => (
            <label key={item.id} className="checkbox-row">
              <input
                type="checkbox"
                checked={allowed.includes(item.id)}
                onChange={(event) => setAllowed(event.target.checked ? [...allowed, item.id] : allowed.filter((id) => id !== item.id))}
              />
              {item.title} · ${item.amount}
            </label>
          ))}
        </fieldset>
        <label className="field">
          Spending limit (USD)
          <input inputMode="decimal" value={maxUsd} onChange={(event) => setMaxUsd(event.target.value)} />
        </label>
        <button className="primary" type="button" disabled={busy || !allowed.length || instruction.trim().length < 3} onClick={() => buy().catch(() => undefined)}>
          {busy ? "Agent is shopping…" : "Sign the mandate and let the agent buy"}
        </button>
        <div aria-live="polite">
          {error && <p className="error">{error}</p>}
          {result && (
            <>
              <p className={result.status === "bought" ? "okmsg" : "error"}>
                {result.status === "bought" ? `Bought ${result.pick.title}. Order ${result.orderId}.` : `Blocked: ${result.pick.title} is outside the mandate. No order was created.`}
              </p>
              <ol className="agent-steps">
                {result.steps.map((step) => (
                  <li key={step.step} className={step.state}>
                    <strong>{step.step}</strong> {step.detail}
                  </li>
                ))}
              </ol>
              {result.customId && <p className="path mono">custom_id {result.customId}</p>}
            </>
          )}
        </div>
        {result?.status === "bought" && (
          <div className="sandbox-box">
            <label className="field">
              Buyer's chargeback text
              <textarea rows={2} value={complaint} onChange={(event) => setComplaint(event.target.value)} />
            </label>
            <button className="danger" type="button" disabled={job?.status === "running"} onClick={() => dispute().catch(() => undefined)}>
              {job?.status === "running" ? "Filing…" : "Buyer disputes it: \"my AI did that\""}
            </button>
            {job && (
              <>
                <p className="meta">{job.note}</p>
                <ul className="steps">
                  {job.steps.map((step) => <li key={step.id} className={step.state}>{step.label}</li>)}
                </ul>
                {job.error && <p className="error">{job.error}</p>}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

const DECISION_LABEL: Record<Recommendation["decision"], string> = {
  contest: "Contest",
  accept: "Accept",
  review: "Your call",
  wait: "Waiting on PayPal",
  done: "Done",
};

/** Fight or fold, computed by code from records. The merchant still approves every write. */
export function DecisionBanner({ rec }: { rec: Recommendation | undefined }) {
  if (!rec) return null;
  return (
    <section className={`decision ${rec.decision}`} aria-label="Recommendation">
      <p className="decision-head">
        <span className="decision-tag">{DECISION_LABEL[rec.decision]}</span> {rec.headline}
      </p>
      {rec.reasons.length > 0 && (
        <ul>
          {rec.reasons.map((reason) => (
            <li key={reason.text}>
              {reason.text} <span className="meta">· {reason.source}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="meta">Computed by code from the dispute and order records. The model does not decide this.</p>
    </section>
  );
}

/** The mandate check: what the buyer signed, what the agent bought, and every check with its source. */
export function MandateProof({ proof, disputeId }: { proof: AgentProof | null | undefined; disputeId: string }) {
  if (!proof) return null;
  const integrity = proof.checks.filter((check) => check.group === "integrity");
  const constraints = proof.checks.filter((check) => check.group === "constraint");
  return (
    <section className="panel proof" aria-label="Agent mandate check">
      <h3>Agent purchase proof</h3>
      <p className={`verdict ${proof.verdict}`}>{proof.label}</p>
      {proof.verdict === "no_mandate" && (
        <p className="meta">The buyer says an AI agent made this purchase, but the PayPal order carries no ap2: custom_id, so there is no signed mandate to check.</p>
      )}
      {proof.summary && (
        <dl className="proof-summary">
          <dt>Buyer told the agent</dt>
          <dd>"{proof.summary.instruction}"</dd>
          <dt>Mandate allowed</dt>
          <dd>{proof.summary.acceptableItems.join(", ")} · qty {proof.summary.quantity} · up to {proof.summary.limit}</dd>
          <dt>Valid</dt>
          <dd>{proof.summary.validFrom} to {proof.summary.validUntil}</dd>
          <dt>Agent bought</dt>
          <dd>{proof.summary.bought} · {proof.summary.total}</dd>
        </dl>
      )}
      {[{ title: "Records match", rows: integrity }, { title: "Purchase within the mandate", rows: constraints }].map((group) =>
        group.rows.length ? (
          <div key={group.title}>
            <h4>{group.title}</h4>
            <ul className="checks">
              {group.rows.map((check) => (
                <li key={check.id} className={check.pass ? "pass" : "fail"}>
                  <span className="sr-only">{check.pass ? "Pass:" : "Fail:"}</span> {check.label}
                  <span className="meta"> · {check.detail} · {check.source}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null,
      )}
      <p className="links">
        {proof.transactionId && (
          <a href={`/api/ap2/checkout-mandates/${encodeURIComponent(proof.transactionId)}`} target="_blank" rel="noreferrer">Signed mandates (JSON)</a>
        )}
        {proof.verdict !== "no_mandate" && (
          <a href={`/api/disputes/${encodeURIComponent(disputeId)}/evidence.pdf`} target="_blank" rel="noreferrer">Verification PDF</a>
        )}
      </p>
      {proof.demoKeys && (
        <p className="meta">Demo keys from a public seed: signatures show the records were not changed, not who signed them. The PayPal order's custom_id is the anchor.</p>
      )}
    </section>
  );
}

/** Sandbox-only stand-ins for PayPal's dispute team, so the full loop can finish in a demo. */
export function SandboxControls({ disputeId, sandbox, onChanged }: { disputeId: string; sandbox: SandboxOptions | undefined; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  if (!sandbox?.available) return null;

  async function run(kind: "require-evidence" | "adjudicate", outcome?: "SELLER_FAVOR" | "BUYER_FAVOR") {
    setBusy(true);
    setMessage(null);
    try {
      const result = await api.sandbox(disputeId, kind, outcome);
      setMessage(`Status ${result.status?.replaceAll("_", " ") || "unknown"}. Recovered $${result.recoveredUsd}.`);
      onChanged();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "PayPal rejected the sandbox control.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="sandbox-box" aria-label="Sandbox controls">
      <h4>Play PayPal's side (sandbox only)</h4>
      <p className="meta">{sandbox.reason}</p>
      <div className="preset-row">
        <button className="ghost" type="button" disabled={busy || !sandbox.requireEvidence} onClick={() => run("require-evidence").catch(() => undefined)}>PayPal asks for evidence again</button>
        <button className="primary" type="button" disabled={busy || !sandbox.adjudicate} onClick={() => run("adjudicate", "SELLER_FAVOR").catch(() => undefined)}>PayPal decides: seller wins</button>
        <button className="danger" type="button" disabled={busy || !sandbox.adjudicate} onClick={() => run("adjudicate", "BUYER_FAVOR").catch(() => undefined)}>PayPal decides: buyer wins</button>
      </div>
      <p aria-live="polite" className="meta">{message}</p>
    </section>
  );
}
