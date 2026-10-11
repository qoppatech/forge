use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, TransferChecked};

use crate::{constants::TEST_TOKEN_DECIMALS, ForgeError, Vault};

pub fn create_vault(
    ctx: Context<CreateVault>,
    vault_id: [u8; 32],
    approvers: [Pubkey; 2],
    per_loan_limit: u64,
    outstanding_limit: u64,
) -> Result<()> {
    require!(
        approvers[0] != approvers[1] && approvers.iter().all(|key| *key != Pubkey::default()),
        ForgeError::InvalidApprovers
    );
    require!(
        per_loan_limit > 0 && outstanding_limit >= per_loan_limit,
        ForgeError::InvalidLimits
    );
    ctx.accounts.vault.set_inner(Vault {
        treasury: ctx.accounts.treasury.key(),
        vault_id,
        mint: ctx.accounts.mint.key(),
        token_account: ctx.accounts.vault_token_account.key(),
        approvers,
        treasury_destination: ctx.accounts.treasury_destination.key(),
        per_loan_limit,
        outstanding_limit,
        outstanding_principal: 0,
        disbursement_paused: false,
        pause_seq: 0,
        bump: ctx.bumps.vault,
    });
    Ok(())
}

pub fn fund_vault(ctx: Context<FundVault>, amount: u64) -> Result<()> {
    require!(amount > 0, ForgeError::InvalidAmount);
    token::transfer_checked(
        CpiContext::new(
            ctx.accounts.token_program.key(),
            TransferChecked {
                from: ctx.accounts.source.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                to: ctx.accounts.vault_token_account.to_account_info(),
                authority: ctx.accounts.treasury.to_account_info(),
            },
        ),
        amount,
        ctx.accounts.mint.decimals,
    )
}

#[derive(Accounts)]
#[instruction(vault_id: [u8; 32])]
pub struct CreateVault<'info> {
    #[account(mut)]
    pub treasury: Signer<'info>,
    #[account(
        init,
        payer = treasury,
        space = 8 + Vault::INIT_SPACE,
        seeds = [b"vault", treasury.key().as_ref(), &vault_id],
        bump
    )]
    pub vault: Account<'info, Vault>,
    #[account(constraint = mint.decimals == TEST_TOKEN_DECIMALS @ ForgeError::InvalidMintDecimals)]
    pub mint: Account<'info, Mint>,
    #[account(
        init,
        payer = treasury,
        seeds = [b"tokens", vault.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = vault,
        token::token_program = token_program
    )]
    pub vault_token_account: Account<'info, TokenAccount>,
    #[account(token::mint = mint, token::authority = treasury)]
    pub treasury_destination: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct FundVault<'info> {
    pub treasury: Signer<'info>,
    #[account(
        seeds = [b"vault", vault.treasury.as_ref(), &vault.vault_id],
        bump = vault.bump,
        has_one = treasury,
        has_one = mint
    )]
    pub vault: Account<'info, Vault>,
    pub mint: Account<'info, Mint>,
    #[account(mut, token::mint = mint, token::authority = treasury)]
    pub source: Account<'info, TokenAccount>,
    #[account(
        mut,
        address = vault.token_account,
        token::mint = mint,
        token::authority = vault
    )]
    pub vault_token_account: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}
