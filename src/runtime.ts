export function nodeTooOld(): string | null {
  const major = Number(process.versions.node.split(".")[0]);
  if (major < 22) return `Node ${process.versions.node} is too old. MendCash needs Node 22 or newer.`;
  return null;
}
