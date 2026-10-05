use anchor_lang::prelude::*;

/// Treasury withdrawal proposed by one vault approver and executed by the other.
///
/// `withdrawal_id` is the caller's idempotency key: the PDA can be created once, so a
/// replayed proposal or approval fails instead of moving funds again.
#[account]
#[derive(InitSpace, Debug, PartialEq, Eq)]
pub struct Withdrawal {
    /// Vault whose cash is withdrawn to `Vault::treasury_destination`.
    pub vault: Pubkey,
    /// Vault-scoped identifier used with `vault` to derive the withdrawal PDA.
    pub withdrawal_id: [u8; 32],
    /// Amount in mint base units.
    pub amount: u64,
    /// Per-approver approval flags aligned with `Vault::approvers`; the proposer's flag is set
    /// at proposal.
    pub approvals: [bool; 2],
    /// Current lifecycle state.
    pub state: WithdrawalState,
    /// Unix timestamp when the withdrawal was proposed.
    pub proposed_at: i64,
    /// Unix timestamp when funds moved; zero until executed.
    pub executed_at: i64,
    /// PDA bump for `seeds = [b"withdrawal", vault, withdrawal_id]`.
    pub bump: u8,
}

/// Withdrawal lifecycle state.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, InitSpace, Debug, PartialEq, Eq)]
pub enum WithdrawalState {
    /// Approved by the proposer and waiting for the other configured approver.
    Proposed,
    /// Both approvers approved and the amount was transferred to the treasury destination.
    Executed,
}
