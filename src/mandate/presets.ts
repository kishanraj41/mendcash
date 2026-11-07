/**
 * Demo presets for "Let an agent buy". Shared by the UI and the tests.
 *
 * "Agent overreaches" is built so the mandate guard must block it whatever the shopping agent picks:
 * the buyer's spending limit (15 USD) is below the cheapest item in the whole catalog (18 USD), so any
 * cart fails the signed amount check. The live model still shops; the guard, not the preset, blocks.
 */
export type AgentPreset = { label: string; instruction: string; allowed: string[]; maxUsd: string };

export const WITHIN_MANDATE: AgentPreset = {
  label: "Within the mandate",
  instruction: "Get me something to decorate my laptop, under $20.",
  allowed: ["stickers", "poster"],
  maxUsd: "20",
};

export const OVERREACH: AgentPreset = {
  label: "Agent overreaches",
  instruction: "Buy the brand kit for the launch.",
  allowed: ["stickers", "logo-pack"],
  maxUsd: "15",
};

export const AGENT_PRESETS: AgentPreset[] = [WITHIN_MANDATE, OVERREACH];
