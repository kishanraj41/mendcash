import type { AppConfig } from "../config";

type ExecutableTool = {
  execute?: (args: unknown, options: unknown) => Promise<unknown>;
};

type ToolkitLike = {
  getTools: () => Record<string, ExecutableTool>;
};

let toolkitPromise: Promise<ToolkitLike> | null = null;
let toolkitKey = "";

export async function paypalToolkit(config: AppConfig): Promise<ToolkitLike> {
  const key = `${config.paypal.clientId}:${config.paypal.baseUrl}:${config.invoicingEnabled}`;
  if (!toolkitPromise || toolkitKey !== key) {
    toolkitKey = key;
    toolkitPromise = import("@paypal/agent-toolkit/ai-sdk").then(({ PayPalAgentToolkit }) => {
      return new PayPalAgentToolkit({
        clientId: config.paypal.clientId,
        clientSecret: config.paypal.clientSecret,
        configuration: {
          actions: {
            disputes: { list: true, get: true },
            orders: { get: true },
            invoices: {
              list: true,
              sendReminder: true,
              createConditionalRules: true,
            },
          },
          context: { sandbox: config.sandbox },
        },
      }) as unknown as ToolkitLike;
    });
  }
  if (!toolkitPromise) throw new Error("PayPal toolkit failed to load.");
  return toolkitPromise;
}

export async function callToolkit(config: AppConfig, name: string, args: Record<string, unknown>): Promise<unknown> {
  const toolkit = await paypalToolkit(config);
  const tool = toolkit.getTools()[name];
  if (!tool?.execute) {
    throw new Error(`PayPal toolkit has no executable tool ${name}.`);
  }
  const result = await tool.execute(args, { toolCallId: `mendcash-${name}`, messages: [] });
  if (typeof result === "string") {
    try {
      return JSON.parse(result) as unknown;
    } catch {
      return result;
    }
  }
  return result;
}

export function disputeItems(result: unknown): Array<Record<string, unknown>> {
  const value = unwrap(result);
  if (Array.isArray(value)) return value.filter(isRecord);
  if (isRecord(value) && Array.isArray(value.items)) return value.items.filter(isRecord);
  if (isRecord(value) && Array.isArray(value.disputes)) return value.disputes.filter(isRecord);
  return [];
}

export function unwrap(result: unknown): unknown {
  if (typeof result === "string") {
    try {
      return JSON.parse(result) as unknown;
    } catch {
      return result;
    }
  }
  if (isRecord(result) && typeof result.result === "string") return unwrap(result.result);
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
