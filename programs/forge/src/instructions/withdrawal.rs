use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, TransferChecked};

use crate::{ForgeError, Vault, Withdrawal, WithdrawalState};

fn approver_index(vault: &Vault, signer: &Pubkey) -> Result<usize> {
    vault
        .approvers
        .iter()
        .position(|approver| approver == signer)
        .ok_or_else(|| error!(ForgeError::UnauthorizedApprover))
}

pub fn propose_withdrawal(
    ctx: Context<ProposeWithdrawal>,
    withdrawal_id: [u8; 32],
    amount: u64,
) -> Result<()> {
    let index = approver_index(&ctx.accounts.vault, &ctx.accounts.approver.key())?;
    require!(amount > 0, ForgeError::InvalidAmount);

    let mut approvals = [false; 2];
    approvals[index] = true;
    ctx.accounts.withdrawal.set_inner(Withdrawal {
        vault: ctx.accounts.vault.key(),
        withdrawal_id,
        amount,
        approvals,
        state: WithdrawalState::Proposed,
        proposed_at: Clock::get()?.unix_timestamp,
        executed_at: 0,
        bump: ctx.bumps.withdrawal,
    });
    Ok(())
}

pub fn approve_withdrawal(ctx: Context<ApproveWithdrawal>) -> Result<()> {
    let index = approver_index(&ctx.accounts.vault, &ctx.accounts.approver.key())?;
    let withdrawal = &mut ctx.accounts.withdrawal;
    require!(
        withdrawal.state == WithdrawalState::Proposed,
        ForgeError::InvalidWithdrawalState
    );
    require!(!withdrawal.approvals[index], ForgeError::AlreadyApproved);
    withdrawal.approvals[index] = true;
    // The proposer approved at proposal, so this second distinct approval completes the pair.
    require!(
        withdrawal.approvals == [true; 2],
        ForgeError::InvalidWithdrawalState
    );
    require!(
        ctx.accounts.vault_token_account.amount >= withdrawal.amount,
        ForgeError::InsufficientLiquidity
    );

    let vault = &ctx.accounts.vault;
    let signer_seeds: &[&[u8]] = &[
        b"vault",
        vault.treasury.as_ref(),
        &vault.vault_id,
        &[vault.bump],
    ];
    token::transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            TransferChecked {
                from: ctx.accounts.vault_token_account.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                to: ctx.accounts.treasury_destination.to_account_info(),
                authority: vault.to_account_info(),
            },
            &[signer_seeds],
        ),
        withdrawal.amount,
        ctx.accounts.mint.decimals,
    )?;
    withdrawal.state = WithdrawalState::Executed;
    withdrawal.executed_at = Clock::get()?.unix_timestamp;
    Ok(())
}

#[derive(Accounts)]
#[instruction(withdrawal_id: [u8; 32])]
pub struct ProposeWithdrawal<'info> {
    #[account(mut)]
    pub approver: Signer<'info>,
    #[account(
        seeds = [b"vault", vault.treasury.as_ref(), &vault.vault_id],
        bump = vault.bump
    )]
    pub vault: Account<'info, Vault>,
    #[account(
        init,
        payer = approver,
        space = 8 + Withdrawal::INIT_SPACE,
        seeds = [b"withdrawal", vault.key().as_ref(), &withdrawal_id],
        bump
    )]
    pub withdrawal: Account<'info, Withdrawal>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ApproveWithdrawal<'info> {
    pub approver: Signer<'info>,
    #[account(
        seeds = [b"vault", vault.treasury.as_ref(), &vault.vault_id],
        bump = vault.bump,
        has_one = mint
    )]
    pub vault: Account<'info, Vault>,
    #[account(
        mut,
        seeds = [b"withdrawal", vault.key().as_ref(), &withdrawal.withdrawal_id],
        bump = withdrawal.bump,
        has_one = vault
    )]
    pub withdrawal: Account<'info, Withdrawal>,
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
        address = vault.treasury_destination,
        token::mint = mint,
        token::authority = vault.treasury
    )]
    pub treasury_destination: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}
