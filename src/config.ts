export type AppMode = "live" | "replay";

export type ModelPrices = {
  inputPerMillionUsd: number;
  outputPerMillionUsd: number;
};

export type AppConfig = {
  port: number;
  mode: AppMode;
  sandbox: boolean;
  invoicingEnabled: boolean;
  trustProxy: boolean;
  paypal: {
    clientId: string;
    clientSecret: string;
    webhookId: string;
    merchantId: string;
    baseUrl: string;
    configured: boolean;
    testCard: { number: string; expiry: string; securityCode: string; name: string };
  };
  nebius: {
    apiKey: string;
    baseUrl: string;
    agentModel: string;
    routerModel: string;
    fallbackModel: string;
    configured: boolean;
  };
  prices: Record<string, ModelPrices>;
  caps: {
    maxDailyUsd: number;
    analysesPerIp: number;
    simulationsPerIp: number;
    concurrency: number;
    maxPartialRefundUsd: number;
    maxSessionRefundUsd: number;
    reserveUsd: number;
  };
  /** Empty unless MENDCASH_STATE_FILE is set. Live mode still persists under the OS temp dir. */
  stateFile: string;
};

const BANNED = "Qwen3-235B";

export const DEFAULT_AGENT = "deepseek-ai/DeepSeek-V4.1-Flash-1017";
export const DEFAULT_ROUTER = "Qwen/Qwen3-30B-A3B-Instruct-2507";
export const DEFAULT_FALLBACK = "deepseek-ai/DeepSeek-V4-Pro-0813";
export const DEFAULT_NEBIUS_BASE = "https://api.tokenfactory.nebius.com/v1";
export const DEFAULT_PAYPAL_BASE = "https://api-m.sandbox.paypal.com";

const PUBLISHED_PRICES: Record<string, ModelPrices> = {
  [DEFAULT_AGENT]: { inputPerMillionUsd: 0.3, outputPerMillionUsd: 1.2 },
  [DEFAULT_FALLBACK]: { inputPerMillionUsd: 1.32, outputPerMillionUsd: 3.96 },
  // Router per-token price was not in the Oct 30 table. This default is conservative
  // and overridable. The measured router call in MODELS.md averaged $0.0000087.
  [DEFAULT_ROUTER]: { inputPerMillionUsd: 0.1, outputPerMillionUsd: 0.3 },
};

function num(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n;
}

function assertAllowed(id: string, label: string): void {
  if (id.includes(BANNED)) {
    throw new Error(`${label} is banned (${BANNED}). Refusing to start.`);
  }
}

export function isSandboxBase(url: string): boolean {
  return url.includes("sandbox.paypal.com");
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const agentModel = env.AGENT_MODEL?.trim() || DEFAULT_AGENT;
  const routerModel = env.ROUTER_MODEL?.trim() || DEFAULT_ROUTER;
  const fallbackModel = env.FALLBACK_MODEL?.trim() || DEFAULT_FALLBACK;
  assertAllowed(agentModel, "AGENT_MODEL");
  assertAllowed(routerModel, "ROUTER_MODEL");
  assertAllowed(fallbackModel, "FALLBACK_MODEL");

  const baseUrl = (env.PAYPAL_BASE_URL?.trim() || DEFAULT_PAYPAL_BASE).replace(/\/$/, "");
  const clientId = env.PAYPAL_CLIENT_ID?.trim() || "";
  const clientSecret = env.PAYPAL_CLIENT_SECRET?.trim() || "";
  const configured = Boolean(clientId && clientSecret);
  const forced = env.MENDCASH_MODE?.trim();
  let mode: AppMode;
  if (forced === "live" || forced === "replay") mode = forced;
  else mode = configured ? "live" : "replay";

  const prices: Record<string, ModelPrices> = { ...PUBLISHED_PRICES };
  for (const id of [agentModel, routerModel, fallbackModel]) {
    if (!prices[id]) {
      prices[id] = {
        inputPerMillionUsd: num(env.MODEL_PRICE_IN_PER_M, 5),
        outputPerMillionUsd: num(env.MODEL_PRICE_OUT_PER_M, 15),
      };
    }
  }
  if (env.ROUTER_PRICE_IN_PER_M || env.ROUTER_PRICE_OUT_PER_M) {
    prices[routerModel] = {
      inputPerMillionUsd: num(env.ROUTER_PRICE_IN_PER_M, prices[routerModel].inputPerMillionUsd),
      outputPerMillionUsd: num(env.ROUTER_PRICE_OUT_PER_M, prices[routerModel].outputPerMillionUsd),
    };
  }

  return {
    port: num(env.PORT, 3000) || 3000,
    mode,
    sandbox: isSandboxBase(baseUrl),
    invoicingEnabled: env.INVOICING_ENABLED === "true",
    trustProxy: env.TRUST_PROXY !== "0",
    paypal: {
      clientId,
      clientSecret,
      webhookId: env.PAYPAL_WEBHOOK_ID?.trim() || "",
      merchantId: env.PAYPAL_MERCHANT_ID?.trim() || "",
      baseUrl,
      configured,
      testCard: {
        number: env.PAYPAL_TEST_CARD_NUMBER?.trim() || "4012888888881881",
        expiry: env.PAYPAL_TEST_CARD_EXPIRY?.trim() || "2030-12",
        securityCode: env.PAYPAL_TEST_CARD_CVV?.trim() || "123",
        name: "Test Buyer",
      },
    },
    nebius: {
      apiKey: env.NEBIUS_API_KEY?.trim() || "",
      baseUrl: (env.NEBIUS_BASE_URL?.trim() || DEFAULT_NEBIUS_BASE).replace(/\/$/, ""),
      agentModel,
      routerModel,
      fallbackModel,
      configured: Boolean(env.NEBIUS_API_KEY?.trim()),
    },
    prices,
    caps: {
      maxDailyUsd: num(env.MAX_DAILY_USD, 2),
      // Repeat views of the same buyer text are free. 400 lets one visitor open the seeded inbox.
      // MAX_DAILY_USD is the money stop.
      analysesPerIp: num(env.MAX_ANALYSES_PER_IP, 400),
      simulationsPerIp: num(env.MAX_SIMULATIONS_PER_IP, 5),
      concurrency: Math.max(1, num(env.MAX_CONCURRENCY, 4)),
      maxPartialRefundUsd: num(env.MAX_PARTIAL_REFUND_USD, 200),
      maxSessionRefundUsd: num(env.MAX_SESSION_REFUND_USD, 500),
      reserveUsd: 0.008,
    },
    stateFile: env.MENDCASH_STATE_FILE?.trim() || "",
  };
}

export function modeLabel(config: AppConfig): string {
  if (config.mode === "replay") {
    return "Replay — not a live PayPal call. Disputes are fixtures.";
  }
  return config.sandbox ? "PayPal sandbox." : "PayPal live API.";
}
