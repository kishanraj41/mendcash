import type { ModelPrices } from "../config";

export type TokenUsage = {
  prompt_tokens: number;
  completion_tokens: number;
};

/** Recorded agent usage that prices to $0.0052008 at the Flash rates in MODELS.md. */
export const RECORDED_AGENT_USAGE: TokenUsage = {
  prompt_tokens: 12_000,
  completion_tokens: 1_334,
};

export const RECORDED_ROUTER_USAGE: TokenUsage = {
  prompt_tokens: 80,
  completion_tokens: 12,
};

export function priceMicroUsd(usage: TokenUsage, price: ModelPrices): number {
  const inRate = Math.round(price.inputPerMillionUsd * 1_000_000);
  const outRate = Math.round(price.outputPerMillionUsd * 1_000_000);
  const scaled = usage.prompt_tokens * inRate + usage.completion_tokens * outRate;
  return Math.round(scaled / 1_000_000);
}

export function microToUsd(micro: number): number {
  return micro / 1_000_000;
}

export function formatUsdAmount(micro: number): string {
  return (micro / 1_000_000).toFixed(6);
}
