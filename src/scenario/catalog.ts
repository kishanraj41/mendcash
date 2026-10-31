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
  sandboxActionable: boolean;
};

export const CATALOG: CatalogItem[] = [
  { id: "poster", title: "Poster A3", amount: "25.00", kind: "physical" },
  { id: "brand-kit", title: "Brand kit", amount: "120.00", kind: "digital" },
  { id: "logo-pack", title: "Logo pack", amount: "60.00", kind: "digital" },
  { id: "stickers", title: "Sticker sheet", amount: "18.00", kind: "physical" },
  { id: "mug", title: "Enamel mug", amount: "32.50", kind: "physical" },
];

/** 4853 is the sandbox code that becomes WAITING_FOR_SELLER_RESPONSE. The others often stay under review. */
export const REASON_OPTIONS: ReasonOption[] = [
  { code: "4853", reason: "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED", label: "Not as described", sandboxActionable: true },
  { code: "4855", reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED", label: "Not received", sandboxActionable: false },
  { code: "4837", reason: "OTHER", label: "Other / unauthorized", sandboxActionable: false },
];

export function reasonByCode(code: string): ReasonOption | undefined {
  return REASON_OPTIONS.find((r) => r.code === code);
}
