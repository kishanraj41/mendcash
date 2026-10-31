import type { CatalogItem } from "../scenario/catalog";

export type CardOrderInput = {
  item: CatalogItem;
  reference: string;
  card: { number: string; expiry: string; securityCode: string; name: string };
};

export function cardOrderBody(input: CardOrderInput): Record<string, unknown> {
  return {
    intent: "CAPTURE",
    purchase_units: [
      {
        reference_id: input.reference,
        description: input.item.title,
        amount: { currency_code: "USD", value: input.item.amount },
        soft_descriptor: "MENDCASH",
      },
    ],
    payment_source: {
      card: {
        name: input.card.name,
        number: input.card.number,
        expiry: input.card.expiry,
        security_code: input.card.securityCode,
        billing_address: {
          address_line_1: "2211 N First Street",
          admin_area_2: "San Jose",
          admin_area_1: "CA",
          postal_code: "95131",
          country_code: "US",
        },
      },
    },
  };
}

export type ChargebackInput = {
  merchantId: string;
  captureId: string;
  amount: string;
  currency?: string;
  reasonCode: string;
  notes: string;
  responseDate: string;
  receiveDate: string;
  cardBrand: string;
  networkTransactionId?: string;
};

/**
 * Sandbox-only helper. Shape follows PayPal's dispute test docs and the
 * Oct 31 sandbox calls that returned 201 with a dispute_id.
 * https://developer.paypal.com/disputes/test-go-live/
 */
export function processChargebackBody(input: ChargebackInput): Record<string, unknown> {
  return {
    adjacency: "PAYPAL",
    file_layout: "ATCK_CB",
    merchant_id: input.merchantId,
    financial_institution: { processor: "FDMS" },
    transaction: {
      id_enc: input.captureId,
      amount: { currency_code: input.currency || "USD", value: input.amount },
    },
    instrument: {
      instrument_type: "CARD",
      card_brand: input.cardBrand,
      credit_card_transaction_id: input.networkTransactionId || input.captureId,
      external: false,
    },
    dispute: {
      id: null,
      stage: "CHARGEBACK",
      response_date: input.responseDate,
      status: "2",
      amount: { currency_code: input.currency || "USD", value: input.amount },
      receive_date: input.receiveDate,
      event_code: "CHARGEBACK_INITIATED",
      money_movement_date: input.receiveDate,
      event_type: "DEBIT",
      chargeback_type: "REPORTED_TO_PROCESSOR",
      processor_info: {
        reference_number: input.captureId.replace(/\W/g, "").slice(0, 24) || "31639435342702423793399",
        reason_code: input.reasonCode,
        notes: input.notes.slice(0, 2000),
      },
    },
  };
}

export function trackingBody(input: {
  captureId: string;
  carrier: string;
  trackingNumber: string;
}): Record<string, unknown> {
  return {
    capture_id: input.captureId,
    tracking_number: input.trackingNumber,
    carrier: input.carrier,
    notify_payer: false,
  };
}
