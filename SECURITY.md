# Security

MendCash is a hackathon project that runs against the PayPal **sandbox**. Do not point it at a live PayPal account.

## Reporting a problem

Please open a [private security advisory](https://github.com/kishanraj41/mendcash/security/advisories/new) rather than a public issue. Include the steps to reproduce and what you expected. You should hear back within a week.

## What the design already enforces

- Nothing is written to PayPal until a person approves the exact request. Buyer text is data, never instructions.
- Amounts and deadlines come from PayPal records through code, not from the model.
- Writes are limited to disputes this demo created, with per-address and daily caps.
- Evidence file bytes never reach the browser; the preview shows the file's size and SHA-256.
- Secrets live only in environment variables. They are never committed or logged.

## Known limits

- Demo mandate keys come from a public seed (`MANDATE_KEY_SEED` unset). They prove records were not altered, not who signed them.
- `GET /api/ap2/checkout-mandates/:transactionId` is unauthenticated in the demo. A production verifier would require the merchant's credentials.
