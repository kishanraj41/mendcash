import { randomBytes } from "crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import fs from "fs";
import path from "path";
import { loadConfig, type AppConfig } from "./config";
import { CapError } from "./caps/limiter";
import { Desk } from "./services/desk";
import type { ActionName } from "./approval/payload";
import { loadLocalEnv, nodeTooOld } from "./runtime";
import { StatusError } from "./errors";

const ACTIONS = new Set<ActionName>([
  "provide_evidence",
  "add_tracking",
  "accept_claim",
  "partial_refund",
  "send_invoice_reminder",
  "create_early_payment_discount",
]);

export type AppOptions = {
  config?: AppConfig;
  now?: () => Date;
  desk?: Desk;
};

export function createApp(options: AppOptions = {}) {
  const config = options.config || loadConfig();
  const desk = options.desk || new Desk(config, options.now);
  const sessions = new Map<string, SessionRec>();
  const app = express();
  app.disable("x-powered-by");
  if (config.trustProxy) app.set("trust proxy", 1);

  app.get("/health", (_req, res) => {
    res.status(200).json({ ok: true, service: "mendcash" });
  });
  app.get("/healthz", (_req, res) => {
    res.status(200).json({ ok: true, service: "mendcash" });
  });

  app.post("/webhooks/paypal", express.raw({ type: "application/json", limit: "1mb" }), async (req, res, next) => {
    try {
      if (config.mode === "live" && !config.paypal.webhookId) {
        res.status(503).json({
          error: "PAYPAL_WEBHOOK_ID is not set. Unsigned events are rejected. The inbox still polls PayPal.",
        });
        return;
      }
      const raw = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : "";
      const event = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      const replayHeader = req.header("x-mendcash-replay") === "1";
      const headers = paypalHeaders(req);
      const stored = await desk.verifyAndIngest(headers, event, replayHeader);
      res.status(200).json({ ok: true, replay: stored.replay, verified: stored.verified, id: stored.id });
    } catch (error) {
      next(error);
    }
  });

  app.use(express.json({ limit: "1mb" }));

  app.get("/api/session", async (req, res, next) => {
    try {
      const csrfToken = ensureSession(req, res, sessions);
      const session = desk.session();
      res.json({ ...session, csrfToken, atStakeUsd: await desk.atStakeUsd() });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/catalog", (_req, res) => {
    res.json(desk.catalog());
  });

  app.get("/api/disputes", async (_req, res, next) => {
    try {
      res.json({ mode: config.mode, replay: config.mode === "replay", disputes: await desk.listDisputes() });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/disputes/:id", async (req, res, next) => {
    try {
      const flag = req.query.analyze;
      const analyze = flag === "0" || flag === "false" ? false : flag === "1" ? true : "auto";
      res.json(await desk.getCase(req.params.id, clientIp(req), analyze));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/disputes/:id/preview", async (req, res, next) => {
    try {
      requireCsrf(req, sessions);
      const action = actionOf(req.body?.action);
      const preview = await desk.preview(req.params.id, action, fieldsOf(req.body));
      res.json({ replay: config.mode === "replay", ...preview });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/disputes/:id/approve", async (req, res, next) => {
    try {
      requireCsrf(req, sessions);
      const action = actionOf(req.body?.action);
      if (action === "send_invoice_reminder" || action === "create_early_payment_discount") {
        res.json(await desk.approveInvoice(req.params.id, action));
        return;
      }
      res.json(await desk.approve(req.params.id, action, fieldsOf(req.body), clientIp(req)));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/simulate", async (req, res, next) => {
    try {
      requireCsrf(req, sessions);
      const started = desk.simulate(
        {
          itemId: String(req.body?.itemId || ""),
          reasonCode: String(req.body?.reasonCode || ""),
          complaint: String(req.body?.complaint || ""),
        },
        clientIp(req),
        req.header("x-mendcash-instant") === "1",
      );
      if (req.query.wait === "1" && config.mode === "replay") await started.done;
      res.status(202).json(desk.job(started.job.id));
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/simulate/:id", (req, res) => {
    const job = desk.job(req.params.id);
    if (!job) {
      res.status(404).json({ error: "Simulation not found." });
      return;
    }
    res.json(job);
  });

  app.get("/api/timeline", (_req, res) => {
    res.json({ events: desk.timelineAll() });
  });

  app.get("/api/invoices", (_req, res) => {
    res.json(desk.invoicesView());
  });

  const webDist = path.resolve(__dirname, "../web/dist");
  if (fs.existsSync(webDist)) {
    app.use(express.static(webDist));
    app.use((req, res, next) => {
      if (req.method !== "GET" && req.method !== "HEAD") return next();
      if (req.path.startsWith("/api") || req.path.startsWith("/webhooks") || req.path.startsWith("/health")) return next();
      res.sendFile(path.join(webDist, "index.html"));
    });
  }

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const message = error instanceof Error ? error.message : "Request failed.";
    const status = error instanceof StatusError
      ? error.status
      : error instanceof CapError
        ? 429
        : /not found/i.test(message)
          ? 404
          : /signature|rejected|session token/i.test(message)
            ? 401
            : 400;
    res.status(status).json({ error: message });
  });

  return { app, desk, config };
}

function clientIp(req: Request): string {
  return req.ip || "unknown";
}

function readCookie(req: Request, name: string): string {
  const raw = req.header("cookie") || "";
  const part = raw.split(";").map((piece) => piece.trim()).find((piece) => piece.startsWith(`${name}=`));
  return part ? decodeURIComponent(part.slice(name.length + 1)) : "";
}

type SessionRec = { csrf: string; seen: number };

function pruneSessions(sessions: Map<string, SessionRec>): void {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const [sid, rec] of sessions) {
    if (rec.seen < cutoff) sessions.delete(sid);
  }
  while (sessions.size > 2000) {
    const oldest = sessions.keys().next().value;
    if (!oldest) break;
    sessions.delete(oldest);
  }
}

function ensureSession(req: Request, res: Response, sessions: Map<string, SessionRec>): string {
  pruneSessions(sessions);
  let sid = readCookie(req, "mendcash_sid");
  let rec = sid ? sessions.get(sid) : undefined;
  if (!sid || !rec) {
    sid = randomBytes(16).toString("hex");
    rec = { csrf: randomBytes(16).toString("hex"), seen: Date.now() };
    sessions.set(sid, rec);
    const secure = req.secure ? "; Secure" : "";
    res.setHeader("Set-Cookie", `mendcash_sid=${sid}; HttpOnly; SameSite=Lax; Path=/${secure}`);
  } else {
    rec.seen = Date.now();
  }
  return rec.csrf;
}

function requireCsrf(req: Request, sessions: Map<string, SessionRec>): void {
  const sid = readCookie(req, "mendcash_sid");
  const rec = sid ? sessions.get(sid) : undefined;
  if (!rec) throw new Error("Missing session token. Reload the page.");
  if (req.header("x-mendcash-csrf") !== rec.csrf) {
    throw new Error("Invalid session token. Reload the page.");
  }
  rec.seen = Date.now();
}

function actionOf(value: unknown): ActionName {
  if (typeof value === "string" && ACTIONS.has(value as ActionName)) return value as ActionName;
  throw new Error("Choose an action. Buyer text cannot choose one.");
}

function fieldsOf(body: unknown): { partialAmount?: string; carrier?: string; trackingNumber?: string } {
  const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  return {
    partialAmount: typeof record.partialAmount === "string" ? record.partialAmount : undefined,
    carrier: typeof record.carrier === "string" ? record.carrier : undefined,
    trackingNumber: typeof record.trackingNumber === "string" ? record.trackingNumber : undefined,
  };
}

function paypalHeaders(req: Request): Record<string, string | undefined> {
  return {
    "paypal-auth-algo": req.header("paypal-auth-algo") || undefined,
    "paypal-cert-url": req.header("paypal-cert-url") || undefined,
    "paypal-transmission-id": req.header("paypal-transmission-id") || undefined,
    "paypal-transmission-sig": req.header("paypal-transmission-sig") || undefined,
    "paypal-transmission-time": req.header("paypal-transmission-time") || undefined,
  };
}

function main(): void {
  loadLocalEnv();
  const tooOld = nodeTooOld();
  if (tooOld) {
    console.error(tooOld);
    process.exit(1);
  }
  const config = loadConfig();
  if (config.mode === "live" && !config.paypal.webhookId) {
    console.warn("PAYPAL_WEBHOOK_ID is not set. Dispute status will refresh by polling, not by webhook.");
  }
  if (config.mode === "live" && !config.paypal.configured) {
    console.error("MENDCASH_MODE=live but PAYPAL_CLIENT_ID or PAYPAL_CLIENT_SECRET is missing.");
    process.exit(1);
  }
  const { app } = createApp({ config });
  app.listen(config.port, () => {
    console.log(`mendcash listening on ${config.port} (${config.mode})`);
  });
}

if (require.main === module) {
  main();
}
