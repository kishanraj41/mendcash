const PATTERNS: Array<{ id: string; re: RegExp }> = [
  { id: "ignore_instructions", re: /ignore (all |any )?(previous |prior |above )?(instructions|rules)/i },
  { id: "ignore_rules", re: /ignore (the |all )?rules/i },
  { id: "disregard", re: /disregard (your |all )?(guidelines|rules|instructions)/i },
  { id: "you_are_now", re: /you are now/i },
  { id: "system_prompt", re: /system prompt/i },
  { id: "tool_or_large_refund", re: /\b(accept[-_ ]claim|provide[-_ ]evidence|refund\s+\$?\d{3,})\b/i },
];

export type InjectionHit = { detected: boolean; patterns: string[] };

export function detectInjection(text: string): InjectionHit {
  const patterns = PATTERNS.filter((p) => p.re.test(text)).map((p) => p.id);
  return { detected: patterns.length > 0, patterns };
}

export function allegationFromBuyer(text: string): string {
  const sentences = text.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
  const kept = sentences.filter((s) => !detectInjection(s).detected);
  const joined = kept.join(" ").replace(/\s+/g, " ").trim();
  if (!joined) return "The buyer message did not include a usable allegation.";
  return joined.slice(0, 280);
}

/** Drop dollar amounts the model invented. Code appends PayPal figures separately. */
export function stripModelMoney(text: string): string {
  return text
    .replace(/\$\s?\d[\d,]*(?:\.\d+)?/g, "[amount removed]")
    .replace(/\b\d+\.\d{2}\s*USD\b/gi, "[amount removed]")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    .slice(0, 1500);
}
