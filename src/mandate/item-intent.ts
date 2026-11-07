import { CATALOG } from "../scenario/catalog";
const ALIASES: Record<string, string[]> = {
  "logo-pack": ["logo pack", "logos"], "brand-kit": ["brand kit", "branding kit"],
  stickers: ["sticker sheet", "stickers", "sticker"], poster: ["poster a3", "a3 poster", "poster"],
  mug: ["enamel mug", "mug"],
};
const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
/** Conservative lexical signal, not an interpretation of free-form intent. Multiple named options are accepted. */
export function itemSwapWarning(instruction: string, boughtId: string): string | null {
  const words = ` ${normalize(instruction)} `;
  const named = CATALOG.filter(item => [item.title, ...(ALIASES[item.id] || [])]
    .some(alias => words.includes(` ${normalize(alias)} `)));
  const bought = CATALOG.find(item => item.id === boughtId);
  if (!bought || !named.length || named.some(item => item.id === boughtId)) return null;
  return `Agent bought ${bought.title}, but the buyer asked for ${named.map(item => item.title).join(" or ")}. Review the instruction before contesting.`;
}
