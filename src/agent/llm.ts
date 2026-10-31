import type { AppConfig } from "../config";
import type { ChatClient, ChatMessage } from "./reader";
import type { TokenUsage } from "../money/cost";

type FetchLike = typeof fetch;

export function createNebiusClient(config: AppConfig, fetchImpl: FetchLike = fetch): ChatClient {
  return async (model: string, messages: ChatMessage[]) => {
    if (model.includes("Qwen3-235B")) {
      throw new Error("Refusing banned model.");
    }
    if (!config.nebius.apiKey) {
      throw new Error("NEBIUS_API_KEY is not set.");
    }
    const started = Date.now();
    const response = await fetchImpl(`${config.nebius.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.nebius.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: 1600,
        messages,
        response_format: { type: "json_object" },
      }),
    });
    const raw = await response.text();
    if (!response.ok) {
      throw new Error(`Nebius ${model} failed with HTTP ${response.status}`);
    }
    const body = JSON.parse(raw) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const content = body.choices?.[0]?.message?.content || "";
    const usage: TokenUsage = {
      prompt_tokens: body.usage?.prompt_tokens || 0,
      completion_tokens: body.usage?.completion_tokens || 0,
    };
    return { content, usage, latencyMs: Date.now() - started };
  };
}
