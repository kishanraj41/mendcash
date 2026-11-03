# Agent purchase proof

MendCash answers one new kind of dispute: **"I didn't buy that, my AI did."** It shows that the buyer's own signed mandate authorized the purchase, or that it did not, using PayPal's order record as the anchor.

## How it maps to AP2 v0.2

| AP2 object | `vct` | Signed by | What MendCash checks |
|---|---|---|---|
| Open checkout mandate | `mandate.checkout.open.1` | user key | allowed merchants, acceptable items, quantity, `iat`/`exp`, agent key in `cnf.jwk` |
| Open payment mandate | `mandate.payment.open.1` | user key | `payment.amount_range` (minor units), `payment.allowed_payees`, `payment.reference.conditional_transaction_id` = hash of the open checkout mandate |
| Checkout (cart) | JWT | merchant key | line items, unit amount, total |
| Closed checkout mandate | `mandate.checkout.1` | agent key | `checkout_jwt` and `checkout_hash` |
| Closed payment mandate | `mandate.payment.1` | agent key | `transaction_id` = checkout hash, payee, `payment_amount` |
| Receipts | — | merchant key | `reference` = hash of the closed mandate, `order_id`, `payment_id`, `psp_confirmation_id` |

**The PayPal binding:** `purchase_units[0].custom_id = "ap2:" + transaction_id` (47 characters, under PayPal's 127 limit). A dispute names the capture, the capture leads to the order, and the order's `custom_id` leads to the mandates. AP2 leaves retrieval by `transaction_id` out of scope. MendCash serves it at `GET /api/ap2/checkout-mandates/:transactionId`.

## The 12 checks

**Records match (integrity)**

1. The PayPal order's `custom_id` equals `ap2:` + the bundle's `transaction_id`.
2. The SHA-256 of the checkout JWT recomputes to `transaction_id`.
3. The user signature verifies on both open mandates.
4. The agent signature verifies on both closed mandates, with the key the user bound in `cnf`.
5. The merchant signature verifies on the checkout.
6. The open payment mandate references the open checkout mandate.
7. The receipts name this PayPal order and capture.
8. The PayPal capture amount equals the mandated payment amount.

**Purchase within the mandate (constraints)**

9. The merchant is one the buyer allowed.
10. The item and quantity are ones the buyer allowed.
11. The total is within the spending limit.
12. PayPal's order `create_time` falls inside the mandate window.

**Verdicts:** `no_mandate` (no `ap2:` custom_id), `integrity_failure` (custom_id present but the bundle is missing or any integrity check fails), `outside_mandate` (records intact, a constraint fails), `authorized` (all pass). Only `authorized` attaches the PDF and recommends contesting.

The same constraint code runs twice: as a guard **before** the agent may pay, and again at dispute time against PayPal's record.

## What it does not prove

- **Identity.** Demo keys are derived from a public seed, so anyone can sign with them. The signatures show the records were not altered after the fact. Real deployments need keys issued to the buyer's wallet and the agent platform.
- **SD-JWT.** AP2 uses SD-JWT VCs with selective disclosure. MendCash uses compact JWS (EdDSA / Ed25519) with the same claims.
- **Neutral storage.** The merchant stores the bundle. The PayPal `custom_id` makes later substitution detectable, but it is not a third-party timestamp.
- **PayPal's decision.** The PDF is evidence. PayPal and the card network decide the dispute. In the sandbox, `require-evidence` and `adjudicate` simulate that side only.

## Live checks to run on the sandbox

1. Create an agent order and `GET` it: `custom_id` is on the purchase unit and the capture.
2. Dispute it with reason `4853`, then wait for `WAITING_FOR_SELLER_RESPONSE`.
3. Send evidence: PayPal accepts the `evidence-file` part and the `documents` name.
4. Check that `adjudicate` (`SELLER_FAVOR`) is accepted while the dispute is `UNDER_REVIEW` and PayPal lists the `adjudicate` link, that the `CUSTOMER.DISPUTE.RESOLVED` webhook arrives, and that **Recovered** rises.

Results on Nov 2, 2026 (sandbox, dispute PP-R-KHC-10196083, $18.00, reason 4853): checks 1–3 passed, and PayPal stored the PDF byte for byte. `require-evidence` and `adjudicate` were refused with `ACTION_NOT_ALLOWED_IN_CURRENT_DISPUTE_STATE` until PayPal listed their links, which happened about 3.5 minutes after the seller's evidence landed. After that, both returned 200. After `adjudicate`, PayPal recorded an adjudication (`PAYOUT_TO_BUYER`, reason `REPRESENTED_BY_PAYPAL`), but the chargeback stayed `UNDER_REVIEW` / `UNDER_PAYPAL_REVIEW` for at least 23 minutes. Recovered rises live only once PayPal marks the dispute `RESOLVED` with a seller outcome. In replay, it rises at once.
