# ADR 0003 — Program changes for at-least-once orchestration

Status: accepted (2026-10-05)

## Context

Idempotency analysis of the original program:

| Instruction | Replay-safe | Why |
|---|---|---|
| `create_vault`, `propose_loan` | yes | `init` on PDAs keyed by caller IDs |
| `approve_loan`, `draw_loan`, `repay_loan` | yes | state gates (6010, 6011) |
| `fund_vault` | **no** | amount-based transfer; no Forge state |
| `withdraw_available` | **no** | amount-based transfer; both approvers in one transaction |
| `set_disbursement_paused` | same value only | a delayed stale `false` can undo a newer emergency pause |

## Decision

1. **Replace `withdraw_available` with a proposal flow**, mirroring loans:
   - `propose_withdrawal(withdrawal_id, amount)`, signed by one configured approver, creates `["withdrawal", vault, withdrawal_id]`. The proposal counts as the proposer's approval.
   - `approve_withdrawal`, signed by the other approver, executes the transfer to the immutable `treasury_destination`, then marks the withdrawal `Executed`.
   - The result:
     - `withdrawal_id` is the idempotency key. A replay fails with `Custom(0)` or 6018 instead of moving funds.
     - Each approver signs their own transaction, so no co-signing window and no durable nonces are needed.
     - The chain keeps a record of who approved.
2. **Add an ordering guard to pause.**
   - `Vault.pause_seq` starts at 0.
   - `set_disbursement_paused(paused, expected_seq)` requires `pause_seq == expected_seq`, then increments it. A stale request fails with `StalePauseSequence` (6019).
   - Pause keeps its two-approvers-in-one-transaction signature model, as the specification requires.
3. **Append new errors only.** Codes 6000–6017 are unchanged. New codes are 6018 `InvalidWithdrawalState` and 6019 `StalePauseSequence`.

## Deferred (with reasons)

- **`fund_vault` receipt PDA.** Funding is treasury-initiated and never retried automatically. The off-chain invariant (one live attempt, plus the expiry proof) covers it. Add a receipt when funding becomes automated.
- **Separate rent payer.** Rent is still paid by the treasury and approvers, so custody keys need SOL.
- **`emit_cpi!` events.** The indexer decodes instructions from the IDL, and postings derive from immutable account fields. Add events when decoding cost or third-party indexing justifies it.
- **Approver and treasury rotation, and withdrawal cancellation.** These are product decisions. Losing a key still means migrating to a new vault.

## Consequences

- Account layouts changed: `Vault` gained `pause_seq`, and `Withdrawal` is new. Nothing is deployed, so there is no migration.
- The SDK, API, console and documentation use the new instruction set.
