/** Integer cents. Half-up on a third decimal. Independent of the model. */

export function moneyToCents(value: string): number {
  const trimmed = value.trim();
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error(`Not a money value: ${trimmed}`);
  }
  const neg = trimmed.startsWith("-");
  const unsigned = neg ? trimmed.slice(1) : trimmed;
  const [dollars, fraction = ""] = unsigned.split(".");
  const frac = (fraction + "000").slice(0, 3);
  let cents = Number(dollars) * 100 + Number(frac.slice(0, 2));
  if (Number(frac[2]) >= 5) cents += 1;
  return neg ? -cents : cents;
}

export function centsToMoney(cents: number): string {
  const neg = cents < 0;
  const abs = Math.abs(Math.trunc(cents));
  const dollars = Math.floor(abs / 100);
  const frac = String(abs % 100).padStart(2, "0");
  return `${neg ? "-" : ""}${dollars}.${frac}`;
}

export function formatUsd(cents: number): string {
  return `$${centsToMoney(cents)}`;
}
