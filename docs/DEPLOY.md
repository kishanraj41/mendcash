# Deploy to Render

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/kishanraj41/mendcash)

[`render.yaml`](../render.yaml) defines one free Docker web service built from the [`Dockerfile`](../Dockerfile) (Node 22, multi-stage, runs as the unprivileged `node` user).

1. **Create the service.** Click the button and enter the secrets marked `sync: false`: `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `NEBIUS_API_KEY`, and optionally `PAYPAL_WEBHOOK_ID` and `PAYPAL_MERCHANT_ID`.
2. **Health checks.** Render checks `GET /health` (also available at `/healthz`). Neither endpoint calls PayPal or a model.
3. **Keep it awake.** Set the GitHub Actions repository variable `DEMO_URL` to the service origin, for example `https://mendcash.onrender.com`. The [keep-alive workflow](../.github/workflows/keepalive.yml) pings `DEMO_URL/health` every 10 minutes.
4. **Webhooks (optional).** Register `https://<service>/webhooks/paypal` in the sandbox app for `CUSTOMER.DISPUTE.CREATED`, `CUSTOMER.DISPUTE.UPDATED` and `CUSTOMER.DISPUTE.RESOLVED`, and set `PAYPAL_WEBHOOK_ID`. Without it, status updates by polling.

> [!NOTE]
> The daily spend counter and the read cache live in a small JSON file on the instance. Render's free tier replaces the disk on spin-down or deploy, so a cold instance starts the day fresh. After a cold start, the dashboard counters show Loading for up to about 40 seconds while they are rebuilt from PayPal records.

All environment variables are listed in [CONFIGURATION.md](CONFIGURATION.md).
