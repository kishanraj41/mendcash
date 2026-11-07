/** Both demos share the same spending authority; only the simulated agent behavior differs. */
export type AgentPreset = { label: string; instruction: string; allowed: string[]; maxUsd: string; rogueTest?: boolean };
const SHARED = { allowed: ["logo-pack", "stickers"], maxUsd: "75" };
export const WITHIN_MANDATE: AgentPreset = {
  ...SHARED, label: "Within the mandate", instruction: "Get the logo pack for the launch",
};
export const OVERREACH: AgentPreset = {
  ...SHARED, label: "Rogue agent test", instruction: "Get the logo pack for the launch", rogueTest: true,
};
export const AGENT_PRESETS: AgentPreset[] = [WITHIN_MANDATE, OVERREACH];
