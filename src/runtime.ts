import fs from "fs";
import path from "path";

export function nodeTooOld(): string | null {
  const major = Number(process.versions.node.split(".")[0]);
  if (major < 22) return `Node ${process.versions.node} is too old. MendCash needs Node 22 or newer.`;
  return null;
}

/** Load `.env` from the working directory. Variables already set in the environment win. */
export function loadLocalEnv(cwd = process.cwd()): void {
  const file = path.join(cwd, ".env");
  if (!fs.existsSync(file)) return;
  try {
    process.loadEnvFile(file);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Could not load .env");
  }
}
