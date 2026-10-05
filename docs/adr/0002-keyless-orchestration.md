# ADR 0002 — Keyless orchestration and transaction lifecycle

Status: accepted (2026-10-05)

## Context

- Every Forge instruction is signed by a business actor: the treasury, a configured approver, or the borrower. None is signed by a service key.
- The specification and issues #4 and #6 forbid the service from holding treasury, approver or borrower keys (`docs/FORGE-MVP-v0.1.md:100,187`).
- Assume at-least-once processing everywhere. Two instructions are not replay-safe: `fund_vault`, and the former `withdraw_available` (see ADR 0003).

## Decision

**Roles**

| Role | Who | Key? |
|---|---|---|
| Orchestration (plans, tracking) | `apps/api` + worker | none |
| Authorization | the Forge program | — |
| Signing / custody | treasury, approvers (bank custody or wallets), borrower wallet | each actor's own key |
| Submission | worker, wallet or anyone | none (untrusted) |

- The fee payer is the first required signer of each instruction.
- The service never signs, and never co-signs as fee payer.

**Flow**

1. `prepare`: the API builds the unsigned message (operation memo plus Forge instruction) with the SDK and a `confirmed` blockhash. It persists the message bytes and `lastValidBlockHeight` as attempt N.
2. `sign`: each required signer verifies the decoded plan, then signs locally.
3. `submit`: the API accepts full or partial signatures. Each signature must verify against the *stored* message bytes. Extra instructions or altered messages are rejected. When every signer has signed, the API persists the signed bytes and signature before any broadcast.
4. `broadcast`: the worker rebroadcasts the **same bytes** until the transaction lands or expiry is proven. It never rebuilds a transaction.
5. `reconcile`: the worker records outcomes. Postings, projections and webhooks are written only at `finalized`.

**State**

- Operation: `prepared → submitted → confirmed → finalized`.
  - Terminal alternatives: `failed`, `expired`, `already_applied`, `needs_review`.
- Attempt: `awaiting_signatures → live → landed_ok | landed_err | expired`.
  - A partial unique index allows at most one attempt per operation that can still land.

**Expiry proof**

- The `finalized` block height is greater than `lastValidBlockHeight`, **and** the signature is unknown with `searchTransactionHistory`.
- For attempts still awaiting signatures, the vault indexer must also have caught up, because a signer may have broadcast the transaction itself.
- Only after this proof may a new attempt (a new signature request) be created.

**Error classification** (at `finalized`)

| Signal | Codes | Outcome |
|---|---|---|
| Replay of an `init` | System `Custom(0)` | Compare stored state with intent: `already_applied` or `needs_review` |
| Replay of a state transition | 6010, 6011, 6018 | Verify on-chain state: `already_applied` or `failed` |
| Business rejection | 6012–6015, 6019, token errors | `failed` with reason; never retried |
| Invalid request | anything else | `failed`; alert |

**Idempotency**

- `Idempotency-Key` plus the SHA-256 of the canonical request, unique per institution.
- Same key and same payload returns the original operation. Same key with a different payload returns 409.
- On-chain IDs are derived deterministically from business references: `sha256("forge:<kind>:v1" | scope | ref)`. A retried request therefore targets the same PDA.

**Operation memo.** Each attempt's transaction is an SPL Memo `forge:op:<operationId>:<attemptNo>` followed by exactly one Forge instruction.
- Without it, two identical requests planned in the same slot compile to byte-identical messages. Ed25519 is deterministic, so they share one transaction id and the chain executes only one. The local end-to-end run found this as a signature collision between two concurrent approvals.
- The memo also lets the indexer match transactions a wallet re-signed or modified before broadcasting.

## Consequences

- RPC timeouts, worker crashes and duplicate workers cannot double-execute an operation. Safety comes from persisted signed bytes, the single-live-attempt index and the expiry proof, not from locks.
- Wallets that alter messages (compute-budget or guard instructions) are rejected at submission. Transactions they broadcast themselves are still ingested by the indexer, which matches them by decoded intent.
- `withdraw_available` and `set_disbursement_paused` used two signers on the same transaction, which only fit inside one blockhash window. ADR 0003 removes this for withdrawals. Pause keeps it, using partial-signature collection.
