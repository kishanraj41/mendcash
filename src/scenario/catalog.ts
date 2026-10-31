export type CatalogItem = {
  id: string;
  title: string;
  amount: string;
  kind: "physical" | "digital";
};

export type ReasonOption = {
  code: string;
  reason: string;
  label: string;
};

export const CATALOG: CatalogItem[] = [
  { id: "poster", title: "Poster A3", amount: "25.00", kind: "physical" },
  { id: "brand-kit", title: "Brand kit", amount: "120.00", kind: "digital" },
  { id: "logo-pack", title: "Logo pack", amount: "60.00", kind: "digital" },
  { id: "stickers", title: "Sticker sheet", amount: "18.00", kind: "physical" },
  { id: "mug", title: "Enamel mug", amount: "32.50", kind: "physical" },
];

/** Reason codes exercised in the Oct 31 sandbox log: 4853, 4855, 4837. */
export const REASON_OPTIONS: ReasonOption[] = [
  { code: "4853", reason: "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED", label: "Not as described" },
  { code: "4855", reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED", label: "Not received" },
  { code: "4837", reason: "OTHER", label: "Other / unauthorized" },
];

export function reasonByCode(code: string): ReasonOption | undefined {
  return REASON_OPTIONS.find((r) => r.code === code);
}
