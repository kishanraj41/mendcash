# Configuration

All settings are environment variables, read in [`src/config.ts`](../src/config.ts). Copy [`.env.example`](../.env.example) to `.env` to get started; the npm scripts load it automatically, and a variable already set in the environment takes precedence.

| Variable | Default | Purpose |
|---|---|---|
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` | — | Sandbox REST app credentials. Both set → live mode. |
| `PAYPAL_BASE_URL` | `https://api-m.sandbox.paypal.com` | PayPal API base. Keep the sandbox for demos. |
| `PAYPAL_WEBHOOK_ID` | — | Used by `verify-webhook-signature`. Optional; polling otherwise. |
| `PAYPAL_MERCHANT_ID` | — | Fallback only, if the order omits `purchase_units[0].payee.merchant_id`. |
| `PAYPAL_TEST_CARD_NUMBER`, `_EXPIRY`, `_CVV` | PayPal's published sandbox test card | Card used for simulated and seeded orders. |
| `NEBIUS_API_KEY` | — | Nebius Token Factory key. |
| `NEBIUS_BASE_URL` | `https://api.tokenfactory.nebius.com/v1` | OpenAI-compatible endpoint. |
| `AGENT_MODEL` | `deepseek-ai/DeepSeek-V4.1-Flash-1017` | Reader / drafter. |
| `ROUTER_MODEL` | `Qwen/Qwen3-30B-A3B-Instruct-2507` | Intent router. |
| `FALLBACK_MODEL` | `deepseek-ai/DeepSeek-V4-Pro-0813` | Retry when the agent's JSON is invalid. |
| `ROUTER_PRICE_IN_PER_M`, `ROUTER_PRICE_OUT_PER_M` | `0.10`, `0.30` | Router price per 1M tokens, for cost accounting. |
| `MODEL_PRICE_IN_PER_M`, `MODEL_PRICE_OUT_PER_M` | `5`, `15` | Assumed price for a model id MendCash has no price for. |
| `MENDCASH_MODE` | auto | `live` or `replay`. Auto is live when PayPal keys are set. |
| `MAX_DAILY_USD` | `2` | Daily model-spend stop. |
| `MAX_ANALYSES_PER_IP` | `400` | Fresh reads per address per day. Repeat buyer text is free. |
| `MAX_SIMULATIONS_PER_IP` | `5` | Simulated chargebacks per address per day. |
| `MAX_CONCURRENCY` | `4` | Parallel model calls. |
| `MAX_PARTIAL_REFUND_USD` | `200` | Ceiling for a partial refund. |
| `MAX_SESSION_REFUND_USD` | `500` | Ceiling for all refunds approved in one session. |
| `MENDCASH_STATE_FILE` | OS temp dir | Where live mode keeps today's spend and the read cache. Signed mandates are kept beside it in `mendcash-mandates.json`. |
| `MANDATE_KEY_SEED` | public demo seed | Seed for the demo Ed25519 user, agent, and merchant keys. The default is public, so signatures show integrity, not identity. |
| `SMALL_CLAIM_USD` | `15` | Below this stake, with evidence PayPal asked for missing, the recommendation is to accept. |
| `INVOICING_ENABLED` | `false` | Turns on the invoice-reminder flow. |
| `TRUST_PROXY` | on | Set to `0` when not behind a reverse proxy. |
| `PORT` | `3000` | HTTP port. Render sets it. |
| `SEED_LIVE` | `0` | `1` makes `npm run seed` create real sandbox chargebacks. |

> [!WARNING]
> MendCash refuses to start if any model id is a Qwen3-235B model. In the model study it carried out a planted fake refund in every run. See [MODELS.md](../MODELS.md).
