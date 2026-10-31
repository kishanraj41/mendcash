const REQUIRED = ["PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET", "PAYPAL_WEBHOOK_ID", "NEBIUS_API_KEY"] as const;

export type CredentialLine = { name: (typeof REQUIRED)[number]; state: "set" | "missing" };

export function credentialReport(env: NodeJS.ProcessEnv): CredentialLine[] {
  return REQUIRED.map((name) => ({
    name,
    state: env[name] && env[name]!.trim() ? "set" : "missing",
  }));
}

export function formatCredentialReport(lines: CredentialLine[]): string {
  return lines.map((line) => `${line.name}: ${line.state}`).join("\n");
}
