# Live agent-loop validation

Validated Nov 7, 2026 (CST) on the PayPal sandbox with live Nebius model calls, running the application locally on Node 22.23.4. Runtime source: [`4bb6568`](https://github.com/kishanraj41/mendcash/commit/4bb6568).

## Shared authority, different agent behavior

Both presets allow **Logo pack ($60)** and **Sticker sheet ($18)** with a **$75** ceiling and use the instruction **“Get the logo pack for the launch”**.

- **Within the mandate:** DeepSeek V4.1 Flash selected Logo pack, quantity 1 (source `model`, not a rules fallback). PayPal completed one $60 order, `3KA95216X4669574F`, capture `8A706867P9985005X`.
- **Rogue agent test:** the explicitly simulated agent picked Brand kit ($120). The unchanged constraint guard rejected the cart before any PayPal order was created. No model pick is claimed for this test.

The same $60 order was reused for chargeback `PP-R-TBD-10197041` (reason 4853). No second order was created. This run made one order-creation request, one chargeback request, and one evidence upload; no adjudication request was made in this run.

## Order and capture fingerprint

Selected fields from `GET /v2/checkout/orders/3KA95216X4669574F` (HTTP 200; buyer and merchant details omitted):

```json
{
  "id": "3KA95216X4669574F",
  "status": "COMPLETED",
  "purchase_units": [
    {
      "custom_id": "ap2:z2qeBdXLgq-QV1zn_fbKqzT98h1HBOjFMsAmiAffezs",
      "amount": {
        "currency_code": "USD",
        "value": "60.00",
        "breakdown": {}
      },
      "payments": {
        "captures": [
          {
            "id": "8A706867P9985005X",
            "status": "COMPLETED",
            "amount": {
              "currency_code": "USD",
              "value": "60.00"
            },
            "custom_id": "ap2:z2qeBdXLgq-QV1zn_fbKqzT98h1HBOjFMsAmiAffezs"
          }
        ]
      }
    }
  ]
}
```

The order and capture both return the signed checkout fingerprint. At dispute time all 12 mandate checks passed and code recommended Contest. The signed instruction and purchased item both name Logo pack.

## Evidence acceptance and status

Before upload: `WAITING_FOR_SELLER_RESPONSE`. The approval card showed `mendcash-agent-mandate.pdf`, **9,322 bytes**, SHA-256:

```text
0392999c61a5832fe6e51d10a7c444c19110cb71e507c234c6e5c0fbe5d84565
```

The preview and approved payload carried the same file metadata. The PDF was sent as the multipart `evidence-file` part with the JSON document name. Actual response, with only the relevant link retained:

```http
POST /v1/customer/disputes/PP-R-TBD-10197041/provide-evidence
HTTP 200
```

```json
{"links":[{"href":"https://api-m.sandbox.paypal.com/v1/customer/disputes/PP-R-TBD-10197041","rel":"detail","method":"GET"}]}
```

After upload, `GET /v1/customer/disputes/PP-R-TBD-10197041` returned HTTP 200 with these fields (notes, timestamps and unrelated evidence omitted; document id redacted):

```json
{
  "dispute_id": "PP-R-TBD-10197041",
  "status": "UNDER_REVIEW",
  "evidences": [{
    "evidence_type": "OTHER",
    "source": "SUBMITTED_BY_SELLER",
    "documents": [{
      "name": "mendcash-agent-mandate.pdf",
      "url": "https://api-m.sandbox.paypal.com/v2/content/documents/<document-id>/files/1/download"
    }],
    "action_info": {"action": "PROVIDE_EVIDENCE"}
  }]
}
```

## Byte-for-byte retrieval proof

The disputes API **does return a downloadable document URL**. An authenticated GET of that sandbox URL returned:

| Check | Observed result |
|---|---|
| HTTP status | 200 |
| Content-Type | `application/pdf;charset=UTF-8` |
| Downloaded bytes | 9,322 |
| Downloaded SHA-256 | `0392999c61a5832fe6e51d10a7c444c19110cb71e507c234c6e5c0fbe5d84565` |
| Match against approval-card file | **Exact size and SHA-256 match** |

**Verified wording:** “PayPal accepted the PDF, then returned the stored document with the same SHA-256 as the approval card.” This proves the bytes were preserved for this upload; it does not prove the evidence will win the dispute. A 200 alone would prove acceptance, not byte equality.

Historical sandbox adjudication and resolution behavior are documented in [AGENT_PROOF.md](AGENT_PROOF.md). The README [live-loop table](../README.md#live-agent-loop-paypal-sandbox) summarizes both runs.
