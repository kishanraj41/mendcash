import fs from "fs";
import path from "path";
import type { MandateBundle } from "./ap2";

function isBundle(value: unknown): value is MandateBundle {
  if (!value || typeof value !== "object") return false;
  const b = value as Record<string, unknown>;
  return b.version === 1 && typeof b.transactionId === "string" && /^[A-Za-z0-9_-]{43}$/.test(b.transactionId) &&
    ["openCheckout", "openPayment", "checkoutJwt", "closedCheckout", "closedPayment"].every((key) => typeof b[key] === "string");
}

/** Mandate bundles keyed by AP2 transaction_id (the PayPal order's custom_id minus "ap2:"). */
export class MandateStore {
  private readonly bundles = new Map<string, MandateBundle>();

  constructor(private readonly file: string | null, readOnlyFiles: string[] = []) {
    for (const extra of readOnlyFiles) this.load(extra);
    if (file) this.load(file);
  }

  private load(file: string): void {
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8")) as { version?: number; bundles?: Record<string, unknown> };
      if (raw?.version !== 1 || !raw.bundles || typeof raw.bundles !== "object") return;
      for (const value of Object.values(raw.bundles)) if (isBundle(value)) this.bundles.set(value.transactionId, value);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.error(`Mandate file ${path.basename(file)} could not be read.`);
    }
  }

  get(transactionId: string | null): MandateBundle | null {
    return transactionId ? this.bundles.get(transactionId) || null : null;
  }

  put(bundle: MandateBundle): void {
    this.bundles.set(bundle.transactionId, bundle);
    if (!this.file || bundle.origin === "replay-fixture") return;
    try {
      const own: Record<string, MandateBundle> = {};
      for (const [id, row] of this.bundles) if (row.origin !== "replay-fixture") own[id] = row;
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, bundles: own }), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch (error) {
      console.error(error instanceof Error ? error.message : "Could not save the mandate file.");
    }
  }

  list(): MandateBundle[] {
    return [...this.bundles.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
}
