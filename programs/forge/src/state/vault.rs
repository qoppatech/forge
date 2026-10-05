use anchor_lang::prelude::*;

/// Bank-controlled token vault configuration and accounting state.
///
/// Amount fields are stored in the mint's base units. The vault enforces
/// `outstanding_principal <= outstanding_limit` while loans are drawn and repaid.
#[account]
#[derive(InitSpace, Debug, PartialEq)]
pub struct Vault {
    /// Treasury authority that owns this vault PDA namespace and funding source.
    pub treasury: Pubkey,
    /// Treasury-provided identifier used with `treasury` to derive the vault PDA.
    pub vault_id: [u8; 32],
    /// SPL Token mint accepted by this vault; currently expected to have six decimals.
    pub mint: Pubkey,
    /// PDA-owned token account holding vault liquidity for the configured mint.
    pub token_account: Pubkey,
    /// Two non-default, distinct approvers required for loan approval controls.
    pub approvers: [Pubkey; 2],
    /// Treasury-owned token account that receives administrative withdrawals.
    pub treasury_destination: Pubkey,
    /// Maximum principal, in mint base units, allowed for a single loan.
    pub per_loan_limit: u64,
    /// Maximum aggregate active principal, in mint base units, allowed for this vault.
    pub outstanding_limit: u64,
    /// Aggregate principal, in mint base units, currently drawn and not yet repaid.
    pub outstanding_principal: u64,
    /// Emergency switch that blocks new loan disbursements while preserving repayments.
    pub disbursement_paused: bool,
    /// Number of applied pause changes; callers pass it back to reject stale requests.
    pub pause_seq: u64,
    /// PDA bump for `seeds = [b"vault", treasury, vault_id]`.
    pub bump: u8,
}
