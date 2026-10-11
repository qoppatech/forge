# Prototype walkthrough: decisions and issues

Branch `feat/ts-prototype`. This page maps every architecture-review decision and every open issue to the code that implements it and the evidence that checks it. The detailed evidence is in [validation.md](validation.md).

## Decisions

| # | Decision | Where | Evidence |
|---|---|---|---|
| 1 | TypeScript for the API and worker. Retire the Go scaffold. No gRPC between modules. | [ADR 0001](adr/0001-typescript-backend.md), `apps/api` | Builds; 22 API tests |
| 2 | `@solana/kit` only, with an IDL-driven codec. No `web3.js` v1 or `@anchor-lang/core`. | `packages/sdk/src/{idl,codec,intents}.ts` | IDL drift tests; `bun audit` shows no advisories via kit |
| 3 | The service never holds or co-signs with any key. The fee payer is the first required signer. | [ADR 0002](adr/0002-keyless-orchestration.md), `apps/api/src/operations.ts` | e2e: the API and worker processes receive no key |
| 4 | Plans are verified client-side before signing. | `verifyPlan` in `packages/sdk/src/plan.ts`; console `review.tsx` | SDK tamper and extra-instruction tests |
| 5 | Signed bytes and the signature are persisted before any broadcast. | `Operations.submit` | Test "persisted before broadcast, even when the RPC send fails" |
| 6 | Rebroadcast the same bytes; never rebuild a transaction. | `worker/tracker.ts` | Concurrent-worker test; e2e worker restart |
| 7 | Expiry only with proof: finalized height past `lastValidBlockHeight`, plus a history search, plus an indexer sync. Only then a new attempt. | `Tracker.expireIfProven`, `expireUnsigned`, `Operations.reprepare` | Expiry test; e2e attempt 2 |
| 8 | At most one live attempt per operation. | `tx_attempts_one_live` partial unique index | Re-prepare refused while an attempt is open |
| 9 | Operation memo `forge:op:<id>:<n>` makes every attempt unique and traceable. | SDK `compileIntentTransaction`; reconciler | Found and fixed by e2e; memo tests |
| 10 | Replay errors resolve against chain state (`already_applied` / `needs_review`), never a dead-letter queue. | `worker/classify.ts`, SDK `decodeTransactionError` | e2e duplicate approval; reused-ID test |
| 11 | Postings, events, projections and outbox only at `finalized`, in one DB transaction, deduplicated per signature and instruction. | `worker/reconciler.ts` | e2e replay from empty cursors: counts unchanged |
| 12 | Vault cursor indexer for direct calls, wallet broadcasts and donations, with recovery from pruned history. | `worker/indexer.ts` | e2e donation and self-broadcast; pruned-cursor test |
| 13 | Withdrawals become proposal PDAs, and pause carries a sequence guard. | [ADR 0003](adr/0003-program-idempotency.md), `programs/forge/src/instructions/withdrawal.rs` | 19 LiteSVM tests; e2e stale pause → 6019 |
| 14 | No Kafka, Geyser, events, fund receipts or separate services yet. | ADR 0003, "Deferred" | — |
| 15 | PostgreSQL is the truth for intents and postings; the chain is the truth for state. | `vaults`/`loans`/`withdrawals` are projections | Statement reconciliation: ledger cash = chain cash |

## Issues

### #1 — Local-validator gate

- **Status:** Done, on a disposable loopback validator with the program loaded at genesis.
- **Evidence:**
  - vault created and funded with exactly 10,000,000,000 base units;
  - unauthorized direct SPL withdrawal rejected for both outsider and treasury, with balances unchanged.
- No Devnet or mainnet deployment.

### #3 — SDK builders and typed reads

- **Status:** Done.
- **Coverage:**
  - all 9 instructions;
  - PDAs and typed account decoders;
  - plans with decoded intent, required signers and serialized transaction;
  - error decoding;
  - expiry and overdue views;
  - IDL drift tests.
- The SDK never accepts, stores or generates keys.

### #4 — Keyless orchestration

- **Status:** Done.
- **Coverage:**
  - plan endpoints for all actions;
  - signed-bytes submission and status endpoints;
  - institution-scoped auth, with cross-institution access returning 404;
  - Idempotency-Key with request hash, returning 409 on mismatch;
  - states `prepared` / `submitted` / `confirmed` / `finalized` / `failed` / `expired`, plus `already_applied` and `needs_review`;
  - request validation;
  - unknown routes closed.

### #5 — Finalized reconciliation

- **Status:** Done.
- **Coverage:**
  - polling reconciler with persisted cursors;
  - finalized-only postings;
  - one DB transaction per signature;
  - deduplication by (network, signature, instruction position);
  - stable webhook IDs with signed, at-least-once delivery;
  - donation exceptions;
  - statements linked to signature and slot;
  - replay tests.

### #6 — End-to-end lending flow

- **Status:** Done, with 25 checks.
- **Coverage:**
  - vault cash 10,000 → 5,000 → 10,100 and receivable 0 → 5,000 → 0;
  - premature or repeated draw, repeated repay, wrong signer, wrong account and cross-institution access fail without side effects;
  - replay does not duplicate.

## How to see it

```sh
nix-shell --run 'bash scripts/build.sh && bash scripts/localnet.sh up'
bun run --cwd packages/sdk build
bun run e2e                                   # scripted proof, about 7 minutes
bun run --cwd apps/localnet seed && bun run dev:api   # then, in another shell:
bun run dev:console                           # http://127.0.0.1:3003
```

## Deferred

- **Production custody:** HSM/MPC and wallet adapters. The console uses browser-held demo keys.
- **Durable nonces:** pause still co-signs within one blockhash window.
- **Program:**
  - events (`emit_cpi!`);
  - a treasury funding receipt;
  - a separate rent payer;
  - approver rotation;
  - withdrawal cancellation.
- **Infrastructure:** history-retaining RPC providers and multiple-RPC failover; Kafka or Geyser only when triggered (see the review's phase 4).
