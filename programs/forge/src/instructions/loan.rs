use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, TransferChecked};

use crate::{ForgeError, Loan, LoanState, Vault};

pub fn propose_loan(
    ctx: Context<ProposeLoan>,
    loan_id: [u8; 32],
    principal: u64,
    term_rate_bps: u16,
    term_seconds: i64,
    offer_expiry: i64,
) -> Result<()> {
    let vault = &ctx.accounts.vault;
    require!(
        vault.approvers.contains(&ctx.accounts.approver.key()),
        ForgeError::UnauthorizedApprover
    );
    require!(principal > 0, ForgeError::InvalidAmount);
    require!(term_seconds > 0, ForgeError::InvalidTerm);
    require!(
        principal <= vault.per_loan_limit,
        ForgeError::PerLoanLimitExceeded
    );

    let now = Clock::get()?.unix_timestamp;
    require!(offer_expiry > now, ForgeError::InvalidExpiry);

    let fixed_interest = u64::try_from(
        (principal as u128)
            .checked_mul(term_rate_bps as u128)
            .ok_or(ForgeError::MathOverflow)?
            / 10_000,
    )
    .map_err(|_| error!(ForgeError::MathOverflow))?;
    let fixed_payoff = principal
        .checked_add(fixed_interest)
        .ok_or(ForgeError::MathOverflow)?;

    ctx.accounts.loan.set_inner(Loan {
        vault: vault.key(),
        loan_id,
        borrower: ctx.accounts.borrower.key(),
        destination: ctx.accounts.destination.key(),
        principal,
        term_rate_bps,
        fixed_interest,
        fixed_payoff,
        term_seconds,
        offer_expiry,
        approvals: [false; 2],
        state: LoanState::Proposed,
        proposed_at: now,
        disbursed_at: 0,
        repaid_at: 0,
        bump: ctx.bumps.loan,
    });
    Ok(())
}

pub fn approve_loan(ctx: Context<ApproveLoan>) -> Result<()> {
    let signer = ctx.accounts.approver.key();
    let index = if ctx.accounts.vault.approvers[0] == signer {
        0
    } else if ctx.accounts.vault.approvers[1] == signer {
        1
    } else {
        return err!(ForgeError::UnauthorizedApprover);
    };

    let loan = &mut ctx.accounts.loan;
    require!(
        loan.state == LoanState::Proposed,
        ForgeError::InvalidLoanState
    );
    require!(!loan.approvals[index], ForgeError::AlreadyApproved);
    loan.approvals[index] = true;
    if loan.approvals == [true; 2] {
        loan.state = LoanState::Approved;
    }
    Ok(())
}

pub fn draw_loan(ctx: Context<DrawLoan>) -> Result<()> {
    let vault = &mut ctx.accounts.vault;
    let loan = &mut ctx.accounts.loan;
    require!(
        loan.state == LoanState::Approved,
        ForgeError::InvalidLoanState
    );
    require!(!vault.disbursement_paused, ForgeError::DisbursementPaused);

    let now = Clock::get()?.unix_timestamp;
    require!(now <= loan.offer_expiry, ForgeError::LoanExpired);
    let outstanding = vault
        .outstanding_principal
        .checked_add(loan.principal)
        .ok_or(ForgeError::MathOverflow)?;
    require!(
        outstanding <= vault.outstanding_limit,
        ForgeError::OutstandingLimitExceeded
    );
    require!(
        ctx.accounts.vault_token_account.amount >= loan.principal,
        ForgeError::InsufficientLiquidity
    );

    let vault_treasury = vault.treasury;
    let vault_id = vault.vault_id;
    let vault_bump = vault.bump;
    let signer_seeds: &[&[u8]] = &[b"vault", vault_treasury.as_ref(), &vault_id, &[vault_bump]];
    token::transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            TransferChecked {
                from: ctx.accounts.vault_token_account.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                to: ctx.accounts.destination.to_account_info(),
                authority: vault.to_account_info(),
            },
            &[signer_seeds],
        ),
        loan.principal,
        ctx.accounts.mint.decimals,
    )?;
    vault.outstanding_principal = outstanding;
    loan.state = LoanState::Active;
    loan.disbursed_at = now;
    Ok(())
}

pub fn repay_loan(ctx: Context<RepayLoan>) -> Result<()> {
    let vault = &mut ctx.accounts.vault;
    let loan = &mut ctx.accounts.loan;
    require!(
        loan.state == LoanState::Active,
        ForgeError::InvalidLoanState
    );

    token::transfer_checked(
        CpiContext::new(
            ctx.accounts.token_program.key(),
            TransferChecked {
                from: ctx.accounts.borrower_tokens.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                to: ctx.accounts.vault_token_account.to_account_info(),
                authority: ctx.accounts.borrower.to_account_info(),
            },
        ),
        loan.fixed_payoff,
        ctx.accounts.mint.decimals,
    )?;
    vault.outstanding_principal = vault
        .outstanding_principal
        .checked_sub(loan.principal)
        .ok_or(ForgeError::MathUnderflow)?;
    loan.state = LoanState::Repaid;
    loan.repaid_at = Clock::get()?.unix_timestamp;
    Ok(())
}

pub fn set_disbursement_paused(
    ctx: Context<SetDisbursementPaused>,
    paused: bool,
    expected_seq: u64,
) -> Result<()> {
    require!(
        ctx.accounts.approver_a.key() != ctx.accounts.approver_b.key(),
        ForgeError::InvalidApprovers
    );
    require!(
        ctx.accounts
            .vault
            .approvers
            .contains(&ctx.accounts.approver_a.key())
            && ctx
                .accounts
                .vault
                .approvers
                .contains(&ctx.accounts.approver_b.key()),
        ForgeError::UnauthorizedApprover
    );
    let vault = &mut ctx.accounts.vault;
    require!(
        vault.pause_seq == expected_seq,
        ForgeError::StalePauseSequence
    );
    vault.disbursement_paused = paused;
    vault.pause_seq = vault
        .pause_seq
        .checked_add(1)
        .ok_or(ForgeError::MathOverflow)?;
    Ok(())
}

#[derive(Accounts)]
#[instruction(loan_id: [u8; 32])]
pub struct ProposeLoan<'info> {
    #[account(mut)]
    pub approver: Signer<'info>,
    #[account(
        seeds = [b"vault", vault.treasury.as_ref(), &vault.vault_id],
        bump = vault.bump,
        has_one = mint
    )]
    pub vault: Account<'info, Vault>,
    #[account(
        init,
        payer = approver,
        space = 8 + Loan::INIT_SPACE,
        seeds = [b"loan", vault.key().as_ref(), &loan_id],
        bump
    )]
    pub loan: Account<'info, Loan>,
    /// CHECK: The borrower is stored as the designated loan participant.
    pub borrower: UncheckedAccount<'info>,
    #[account(
        token::mint = mint,
        constraint = destination.owner == borrower.key() @ ForgeError::InvalidDestination
    )]
    pub destination: Account<'info, TokenAccount>,
    pub mint: Account<'info, Mint>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ApproveLoan<'info> {
    pub approver: Signer<'info>,
    #[account(
        seeds = [b"vault", vault.treasury.as_ref(), &vault.vault_id],
        bump = vault.bump
    )]
    pub vault: Account<'info, Vault>,
    #[account(
        mut,
        seeds = [b"loan", vault.key().as_ref(), &loan.loan_id],
        bump = loan.bump,
        has_one = vault
    )]
    pub loan: Account<'info, Loan>,
}

#[derive(Accounts)]
pub struct DrawLoan<'info> {
    pub borrower: Signer<'info>,
    #[account(
        mut,
        seeds = [b"vault", vault.treasury.as_ref(), &vault.vault_id],
        bump = vault.bump,
        has_one = mint
    )]
    pub vault: Account<'info, Vault>,
    #[account(
        mut,
        seeds = [b"loan", vault.key().as_ref(), &loan.loan_id],
        bump = loan.bump,
        has_one = vault,
        constraint = loan.borrower == borrower.key() @ ForgeError::InvalidBorrower
    )]
    pub loan: Account<'info, Loan>,
    pub mint: Account<'info, Mint>,
    #[account(
        mut,
        address = vault.token_account,
        token::mint = mint,
        token::authority = vault
    )]
    pub vault_token_account: Account<'info, TokenAccount>,
    #[account(
        mut,
        address = loan.destination,
        token::mint = mint,
        constraint = destination.owner == borrower.key() @ ForgeError::InvalidDestination
    )]
    pub destination: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct RepayLoan<'info> {
    pub borrower: Signer<'info>,
    #[account(
        mut,
        seeds = [b"vault", vault.treasury.as_ref(), &vault.vault_id],
        bump = vault.bump,
        has_one = mint
    )]
    pub vault: Account<'info, Vault>,
    #[account(
        mut,
        seeds = [b"loan", vault.key().as_ref(), &loan.loan_id],
        bump = loan.bump,
        has_one = vault,
        constraint = loan.borrower == borrower.key() @ ForgeError::InvalidBorrower
    )]
    pub loan: Account<'info, Loan>,
    pub mint: Account<'info, Mint>,
    #[account(
        mut,
        token::mint = mint,
        token::authority = borrower
    )]
    pub borrower_tokens: Account<'info, TokenAccount>,
    #[account(
        mut,
        address = vault.token_account,
        token::mint = mint,
        token::authority = vault
    )]
    pub vault_token_account: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct SetDisbursementPaused<'info> {
    pub approver_a: Signer<'info>,
    pub approver_b: Signer<'info>,
    #[account(
        mut,
        seeds = [b"vault", vault.treasury.as_ref(), &vault.vault_id],
        bump = vault.bump
    )]
    pub vault: Account<'info, Vault>,
}
