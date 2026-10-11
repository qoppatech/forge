use anchor_lang::prelude::*;

#[error_code]
pub enum ForgeError {
    #[msg("Approvers must be distinct, nondefault public keys")]
    InvalidApprovers,
    #[msg("Limits must be positive and per-loan limit cannot exceed portfolio limit")]
    InvalidLimits,
    #[msg("FORGE_TEST_USD requires six decimals")]
    InvalidMintDecimals,
    #[msg("Funding amount must be positive")]
    InvalidAmount,
    #[msg("The signer is not a configured approver")]
    UnauthorizedApprover,
    #[msg("Loan term must be positive")]
    InvalidTerm,
    #[msg("Offer expiry must be in the future")]
    InvalidExpiry,
    #[msg("Loan principal exceeds the per-loan limit")]
    PerLoanLimitExceeded,
    #[msg("Loan arithmetic overflowed")]
    MathOverflow,
    #[msg("Loan arithmetic underflowed")]
    MathUnderflow,
    #[msg("Loan is in an invalid state for this instruction")]
    InvalidLoanState,
    #[msg("This approver has already approved the loan")]
    AlreadyApproved,
    #[msg("Disbursement is paused")]
    DisbursementPaused,
    #[msg("Loan offer has expired")]
    LoanExpired,
    #[msg("Outstanding principal limit exceeded")]
    OutstandingLimitExceeded,
    #[msg("Vault has insufficient liquidity")]
    InsufficientLiquidity,
    #[msg("Borrower does not match the loan")]
    InvalidBorrower,
    #[msg("Destination does not belong to the borrower")]
    InvalidDestination,
    #[msg("Withdrawal is in an invalid state for this instruction")]
    InvalidWithdrawalState,
    #[msg("Pause request was built against a stale pause sequence")]
    StalePauseSequence,
}
