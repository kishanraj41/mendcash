# Contributing

Thanks for helping. MendCash runs fully offline in replay mode, so you can work without PayPal or Nebius keys.

## Setup

```bash
npm ci
MENDCASH_MODE=replay npm run dev
```

## Before you open a pull request

```bash
npm run typecheck
npm test
npm run eval      # must print OK
npm run build
```

CI runs the same four commands.

## Rules that keep the demo safe

- The model never sets an amount, a deadline, or a decision. Code computes them from PayPal records.
- Every PayPal write goes through the approval gate (`src/approval/gate.ts`).
- Planted fixtures change only through `npm run seed`, and `fixtures/ground_truth.json` must match.
- No credentials, real customer data, or live PayPal ids in commits.

## Style

TypeScript strict mode and small modules. Write plain error messages that say what happened and that nothing was sent.
