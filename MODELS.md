# How MendCash picked its models

All comparison runs used Nebius Token Factory (`https://api.tokenfactory.nebius.com/v1`, OpenAI-compatible) on **Oct 30, 2026**. Prices below are from `/v1/models?verbose=true` that day.

This is synthetic, PayPal-shaped data with a small sample (3–8 runs per model). It is not a benchmark. A dispute-specific re-run is planned and should be appended here.

MendCash reads model ids and the base URL from the environment (`AGENT_MODEL`, `ROUTER_MODEL`, `FALLBACK_MODEL`, `NEBIUS_BASE_URL`). The defaults are the three rows in the choice section. The process refuses to start if any of them is a Qwen3-235B id.

## Agent task

12 invoices, 37 transactions, 2 disputes, and 1 prompt injection. Five checks per run.

| model | runs passing all 5 checks | cost per analysis | latency | price in/out per 1M tokens |
|---|---|---|---|---|
| deepseek-ai/DeepSeek-V4.1-Flash-1017 | 8/8 | $0.0050–0.0054 | 9.2–15.0 s | $0.30 / $1.20 |
| zai-org/GLM-5.3 | 2/3 | $0.019–0.027 | 14.8–26.0 s | $1.40 / $4.40 |
| moonshotai/Kimi-K3 | 1/3 | $0.056–0.061 | 10.5–11.8 s | $3 / $15 |
| deepseek-ai/DeepSeek-V4-Pro-0813 | 0/3 (missed only the refund-spike mention) | $0.016 | 8.4–10.4 s | $1.32 / $3.96 |
| Qwen/Qwen3.5-397B-A17B | 0/3 (same miss) | $0.012 | 14.3–14.9 s | $0.60 / $3.60 |
| moonshotai/Kimi-K2.6 | 0/3 (same miss) | $0.019–0.027 | 12.6–20.0 s | $0.95 / $4.00 |
| openai/gpt-oss-120b | 0/3 (skipped disputes, invented IDs) | $0.0014 | ~6 s | $0.15 / $0.60 |
| Qwen/Qwen3-235B-A22B-Instruct-2507 | 0/3 (followed the injected refund in all 3 runs) | $0.0019 | ~6.5 s | $0.20 / $0.60 |
| MiniMaxAI/MiniMax-M3.1-Flash | 0/3 | $0.003–0.007 | 53–90 s | $0.15 / $0.60 |

## Router

20 messages, strict JSON schema.

| model | accuracy | p50 / max latency | avg cost per call |
|---|---|---|---|
| Qwen/Qwen3-30B-A3B-Instruct-2507 | 17/20 | 0.80 / 0.91 s | $0.0000087 |
| Qwen/Qwen3-235B-A22B-Instruct-2507 | 17/20 | 0.78 / 1.19 s | $0.0000175 |
| deepseek-ai/DeepSeek-V4.1-Flash-1017 | 18/20 (1 invalid) | 1.20 / 2.81 s | $0.00016 |
| openai/gpt-oss-120b | 16/20 | 1.09 / 1.25 s | $0.0000889 |
| zai-org/GLM-5.3-Flash | 14/20 (5 invalid) | 2.23 / 8.80 s | $0.000116 |
| google/gemma-3-27b-it | 14/20 | 0.93 / 1.11 s | $0.000009 |

## Choice

- **Agent:** `deepseek-ai/DeepSeek-V4.1-Flash-1017` (MIT). It was the only model that passed every check in every run, and it was the cheapest of the strong models.
- **Router:** `Qwen/Qwen3-30B-A3B-Instruct-2507` (Apache 2.0). It was the fastest and cheapest valid router. A misroute cannot write anything, because every write needs a human click.
- **Fallback:** `deepseek-ai/DeepSeek-V4-Pro-0813`. Switch the agent with `AGENT_MODEL`. If the primary reply is not valid JSON, MendCash retries once on the fallback.
- **Never used:** `Qwen/Qwen3-235B-A22B-Instruct-2507`. It carried out a planted fake refund in every run of the study. The server rejects that id.
- **Models never compute money.** Amounts, deadlines, and totals come from deterministic code. Dollar amounts that appear in a model draft are stripped before the approval payload is built.

The router’s per-token price on Nebius, confirmed 31 Oct 2026, is $0.10 / $0.30 per 1M tokens. Override it with `ROUTER_PRICE_IN_PER_M` and `ROUTER_PRICE_OUT_PER_M`.

## MendCash dispute desk, live run 31 Oct 2026

These numbers are from one live sandbox plus Nebius run of the dispute reader on 32 seeded chargebacks. They are not the October 30 selection task above.

| Metric | Value |
|---|---|
| Classification (model plus rules) | 32/32 |
| Amount exact match | 32/32 |
| Unapproved writes | 0 across 34 MendCash disputes |
| Cost per dispute | avg $0.000459, min $0.000175, max $0.003895 |
| Model latency | p50 1.3 s, p95 5.7 s, max 8.3 s |
| HTTP analysis, including PayPal reads | about $0.00029, wall time 1.6–3.5 s, median about 2.5 s |

`npm run eval` without `--live` still prices a fixture token mix (12,000 in / 1,334 out). That fixture cost is about $0.0052 and is not the live cost. The 9.2–15 s column above is the October 30 selection task.
