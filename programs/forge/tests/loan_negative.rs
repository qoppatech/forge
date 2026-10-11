mod support;

use anchor_lang::solana_program::{clock::Clock, instruction::Instruction, system_program};
use anchor_lang::{AccountDeserialize, InstructionData, ToAccountMetas};
use anchor_spl::token::spl_token::{self, instruction as token_instruction};
use litesvm::types::TransactionResult;
use solana_keypair::Keypair;
use solana_signer::Signer;

use support::*;

const PRINCIPAL: u64 = 2_000_000_000;
const RATE_BPS: u16 = 250;
const INTEREST: u64 = PRINCIPAL * RATE_BPS as u64 / 10_000;
const PAYOFF: u64 = PRINCIPAL + INTEREST;
const TERM_SECONDS: i64 = 60;
const LOAN_ID: [u8; 32] = [9; 32];

struct LoanFixture {
    f: Fixture,
    borrower: Keypair,
    destination: anchor_lang::prelude::Pubkey,
    loan: anchor_lang::prelude::Pubkey,
}

impl LoanFixture {
    fn new() -> Self {
        let mut f = Fixture::new();
        f.initialize();
        for approver in &f.approvers {
            f.svm.airdrop(&approver.pubkey(), 1_000_000_000).unwrap();
        }
        f.execute(f.fund(FUNDING)).unwrap();

        let borrower = Keypair::new();
        f.svm.airdrop(&borrower.pubkey(), 1_000_000_000).unwrap();
        let destination = create_token_account(&mut f.svm, &f.treasury, f.mint, borrower.pubkey());
        let loan = loan_pda(f.vault, LOAN_ID);
        Self {
            f,
            borrower,
            destination,
            loan,
        }
    }

    fn now(&self) -> i64 {
        self.f.svm.get_sysvar::<Clock>().unix_timestamp
    }

    fn set_time(&mut self, unix_timestamp: i64) {
        let mut clock = self.f.svm.get_sysvar::<Clock>();
        clock.unix_timestamp = unix_timestamp;
        self.f.svm.set_sysvar::<Clock>(&clock);
    }

    fn mint_to_destination(&mut self, amount: u64) {
        self.mint_to_token_account(self.destination, amount);
    }

    fn mint_to_source(&mut self, amount: u64) {
        self.mint_to_token_account(self.f.source, amount);
    }

    fn mint_to_token_account(&mut self, account: anchor_lang::prelude::Pubkey, amount: u64) {
        send(
            &mut self.f.svm,
            &self.f.treasury,
            &[token_instruction::mint_to_checked(
                &spl_token::ID,
                &self.f.mint,
                &account,
                &self.f.treasury.pubkey(),
                &[],
                amount,
                6,
            )
            .unwrap()],
            &[],
        )
        .unwrap();
    }

    #[allow(clippy::too_many_arguments)]
    fn propose_ix(
        &self,
        approver: anchor_lang::prelude::Pubkey,
        loan_id: [u8; 32],
        loan: anchor_lang::prelude::Pubkey,
        principal: u64,
        rate_bps: u16,
        term_seconds: i64,
        offer_expiry: i64,
    ) -> Instruction {
        Instruction {
            program_id: forge::ID,
            accounts: forge::accounts::ProposeLoan {
                approver,
                vault: self.f.vault,
                loan,
                borrower: self.borrower.pubkey(),
                destination: self.destination,
                mint: self.f.mint,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
            data: forge::instruction::ProposeLoan {
                loan_id,
                principal,
                term_rate_bps: rate_bps,
                term_seconds,
                offer_expiry,
            }
            .data(),
        }
    }

    fn propose_default(&mut self) {
        let ix = self.propose_ix(
            self.f.approvers[0].pubkey(),
            LOAN_ID,
            self.loan,
            PRINCIPAL,
            RATE_BPS,
            TERM_SECONDS,
            self.now() + 1_000,
        );
        self.f.execute_as_approver(0, ix, None).unwrap();
    }

    fn approve_ix(&self, approver: &Keypair) -> Instruction {
        Instruction {
            program_id: forge::ID,
            accounts: forge::accounts::ApproveLoan {
                approver: approver.pubkey(),
                vault: self.f.vault,
                loan: self.loan,
            }
            .to_account_metas(None),
            data: forge::instruction::ApproveLoan {}.data(),
        }
    }

    fn approve_a(&mut self) {
        let ix = self.approve_ix(&self.f.approvers[0]);
        self.f.execute_as_approver(0, ix, None).unwrap();
    }

    fn approve_b(&mut self) {
        let ix = self.approve_ix(&self.f.approvers[1]);
        self.f.execute_as_approver(1, ix, None).unwrap();
    }

    fn approve_both(&mut self) {
        self.approve_a();
        self.approve_b();
    }

    fn draw_ix(&self) -> Instruction {
        Instruction {
            program_id: forge::ID,
            accounts: forge::accounts::DrawLoan {
                borrower: self.borrower.pubkey(),
                vault: self.f.vault,
                loan: self.loan,
                mint: self.f.mint,
                vault_token_account: self.f.tokens,
                destination: self.destination,
                token_program: spl_token::ID,
            }
            .to_account_metas(None),
            data: forge::instruction::DrawLoan {}.data(),
        }
    }

    fn repay_ix(&self) -> Instruction {
        Instruction {
            program_id: forge::ID,
            accounts: forge::accounts::RepayLoan {
                borrower: self.borrower.pubkey(),
                vault: self.f.vault,
                loan: self.loan,
                mint: self.f.mint,
                borrower_tokens: self.destination,
                vault_token_account: self.f.tokens,
                token_program: spl_token::ID,
            }
            .to_account_metas(None),
            data: forge::instruction::RepayLoan {}.data(),
        }
    }

    fn pause_ix(&self, paused: bool) -> Instruction {
        Instruction {
            program_id: forge::ID,
            accounts: forge::accounts::SetDisbursementPaused {
                approver_a: self.f.approvers[0].pubkey(),
                approver_b: self.f.approvers[1].pubkey(),
                vault: self.f.vault,
            }
            .to_account_metas(None),
            data: forge::instruction::SetDisbursementPaused {
                paused,
                expected_seq: self.vault_state().pause_seq,
            }
            .data(),
        }
    }

    fn withdrawal_pda(&self, withdrawal_id: [u8; 32]) -> anchor_lang::prelude::Pubkey {
        anchor_lang::prelude::Pubkey::find_program_address(
            &[b"withdrawal", self.f.vault.as_ref(), &withdrawal_id],
            &forge::ID,
        )
        .0
    }

    fn propose_withdrawal_ix(
        &self,
        approver: &Keypair,
        withdrawal_id: [u8; 32],
        amount: u64,
    ) -> Instruction {
        Instruction {
            program_id: forge::ID,
            accounts: forge::accounts::ProposeWithdrawal {
                approver: approver.pubkey(),
                vault: self.f.vault,
                withdrawal: self.withdrawal_pda(withdrawal_id),
                system_program: system_program::ID,
            }
            .to_account_metas(None),
            data: forge::instruction::ProposeWithdrawal {
                withdrawal_id,
                amount,
            }
            .data(),
        }
    }

    fn approve_withdrawal_ix(&self, approver: &Keypair, withdrawal_id: [u8; 32]) -> Instruction {
        Instruction {
            program_id: forge::ID,
            accounts: forge::accounts::ApproveWithdrawal {
                approver: approver.pubkey(),
                vault: self.f.vault,
                withdrawal: self.withdrawal_pda(withdrawal_id),
                mint: self.f.mint,
                vault_token_account: self.f.tokens,
                treasury_destination: self.f.source,
                token_program: spl_token::ID,
            }
            .to_account_metas(None),
            data: forge::instruction::ApproveWithdrawal {}.data(),
        }
    }

    /// Approver A proposes and approver B approves, which executes the withdrawal.
    #[allow(clippy::result_large_err)] // LiteSVM's public result type, as in `support`.
    fn withdraw(&mut self, withdrawal_id: [u8; 32], amount: u64) -> TransactionResult {
        let propose = self.propose_withdrawal_ix(&self.f.approvers[0], withdrawal_id, amount);
        self.f.execute_as_approver(0, propose, None)?;
        let approve = self.approve_withdrawal_ix(&self.f.approvers[1], withdrawal_id);
        self.f.execute_as_approver(1, approve, None)
    }

    fn withdrawal_state(&self, withdrawal_id: [u8; 32]) -> forge::Withdrawal {
        let account = self
            .f
            .svm
            .get_account(&self.withdrawal_pda(withdrawal_id))
            .unwrap();
        forge::Withdrawal::try_deserialize(&mut account.data.as_slice()).unwrap()
    }

    fn loan_state(&self) -> forge::Loan {
        let account = self.f.svm.get_account(&self.loan).unwrap();
        forge::Loan::try_deserialize(&mut account.data.as_slice()).unwrap()
    }

    fn vault_state(&self) -> forge::Vault {
        let account = self.f.svm.get_account(&self.f.vault).unwrap();
        forge::Vault::try_deserialize(&mut account.data.as_slice()).unwrap()
    }

    fn balances(&self) -> (u64, u64, u64) {
        (
            self.f.balance(self.f.tokens),
            self.f.balance(self.destination),
            self.vault_state().outstanding_principal,
        )
    }

    fn expect_custom_rollback(
        &mut self,
        ix: Instruction,
        signer: &Keypair,
        extra: &[&Keypair],
        code: u32,
    ) {
        let balances = self.balances();
        let loan_before = self
            .f
            .svm
            .get_account(&self.loan)
            .map(|account| account.data);
        custom_error(self.f.execute_as(signer, ix, extra), code);
        assert_eq!(self.balances(), balances);
        assert_eq!(
            self.f
                .svm
                .get_account(&self.loan)
                .map(|account| account.data),
            loan_before
        );
    }
}

fn loan_pda(
    vault: anchor_lang::prelude::Pubkey,
    loan_id: [u8; 32],
) -> anchor_lang::prelude::Pubkey {
    anchor_lang::prelude::Pubkey::find_program_address(
        &[b"loan", vault.as_ref(), &loan_id],
        &forge::ID,
    )
    .0
}

fn custom_create_ix(
    f: &Fixture,
    vault_id: [u8; 32],
    vault: anchor_lang::prelude::Pubkey,
    tokens: anchor_lang::prelude::Pubkey,
    per_loan_limit: u64,
    outstanding_limit: u64,
) -> Instruction {
    Instruction {
        program_id: forge::ID,
        accounts: forge::accounts::CreateVault {
            treasury: f.treasury.pubkey(),
            vault,
            mint: f.mint,
            vault_token_account: tokens,
            treasury_destination: f.source,
            token_program: spl_token::ID,
            system_program: system_program::ID,
        }
        .to_account_metas(None),
        data: forge::instruction::CreateVault {
            vault_id,
            approvers: f.approvers.each_ref().map(|key| key.pubkey()),
            per_loan_limit,
            outstanding_limit,
        }
        .data(),
    }
}

#[test]
fn propose_loan_rejects_invalid_inputs_and_preserves_state() {
    let mut lf = LoanFixture::new();
    let valid_expiry = lf.now() + 1_000;

    let unauthorized = lf.propose_ix(
        lf.f.outsider.pubkey(),
        LOAN_ID,
        lf.loan,
        PRINCIPAL,
        RATE_BPS,
        TERM_SECONDS,
        valid_expiry,
    );
    let outsider = lf.f.outsider.insecure_clone();
    custom_error(lf.f.execute_as(&outsider, unauthorized, &[]), 6004);
    assert!(lf.f.svm.get_account(&lf.loan).is_none());

    for (loan_id, principal, term_seconds, offer_expiry, code) in [
        ([10; 32], 0, TERM_SECONDS, valid_expiry, 6003),
        ([11; 32], PRINCIPAL, 0, valid_expiry, 6005),
        ([12; 32], PRINCIPAL, TERM_SECONDS, lf.now(), 6006),
        ([13; 32], FUNDING, TERM_SECONDS, valid_expiry, 6007),
    ] {
        let loan = loan_pda(lf.f.vault, loan_id);
        let ix = lf.propose_ix(
            lf.f.approvers[0].pubkey(),
            loan_id,
            loan,
            principal,
            RATE_BPS,
            term_seconds,
            offer_expiry,
        );
        custom_error(lf.f.execute_as_approver(0, ix, None), code);
        assert!(lf.f.svm.get_account(&loan).is_none());
    }
}

#[test]
fn propose_loan_rejects_overflow_and_stores_expected_terms() {
    let mut lf = LoanFixture::new();

    let max_vault_id = [42; 32];
    let max_vault = anchor_lang::prelude::Pubkey::find_program_address(
        &[b"vault", lf.f.treasury.pubkey().as_ref(), &max_vault_id],
        &forge::ID,
    )
    .0;
    let max_tokens = anchor_lang::prelude::Pubkey::find_program_address(
        &[b"tokens", max_vault.as_ref()],
        &forge::ID,
    )
    .0;
    let ix = custom_create_ix(
        &lf.f,
        max_vault_id,
        max_vault,
        max_tokens,
        u64::MAX,
        u64::MAX,
    );
    lf.f.execute(ix).unwrap();
    let overflow_id = [43; 32];
    let overflow_loan = loan_pda(max_vault, overflow_id);
    let mut overflow_ix = lf.propose_ix(
        lf.f.approvers[0].pubkey(),
        overflow_id,
        overflow_loan,
        u64::MAX,
        10_000,
        TERM_SECONDS,
        lf.now() + 1_000,
    );
    overflow_ix.accounts[1].pubkey = max_vault;
    custom_error(lf.f.execute_as_approver(0, overflow_ix, None), 6008);
    assert!(lf.f.svm.get_account(&overflow_loan).is_none());

    lf.propose_default();
    let loan = lf.loan_state();
    assert_eq!(loan.vault, lf.f.vault);
    assert_eq!(loan.loan_id, LOAN_ID);
    assert_eq!(loan.borrower, lf.borrower.pubkey());
    assert_eq!(loan.destination, lf.destination);
    assert_eq!(loan.principal, PRINCIPAL);
    assert_eq!(loan.term_rate_bps, RATE_BPS);
    assert_eq!(loan.fixed_interest, INTEREST);
    assert_eq!(loan.fixed_payoff, PAYOFF);
    assert_eq!(loan.term_seconds, TERM_SECONDS);
    assert!(loan.offer_expiry > lf.now());
    assert_eq!(loan.approvals, [false; 2]);
    assert_eq!(loan.state, forge::LoanState::Proposed);
}

#[test]
fn approve_loan_requires_configured_distinct_approvers_and_preserves_terms() {
    let mut lf = LoanFixture::new();
    lf.propose_default();
    let immutable_terms = {
        let loan = lf.loan_state();
        (
            loan.borrower,
            loan.destination,
            loan.principal,
            loan.term_rate_bps,
            loan.fixed_interest,
            loan.fixed_payoff,
            loan.term_seconds,
            loan.offer_expiry,
        )
    };

    let outsider_approve = Instruction {
        program_id: forge::ID,
        accounts: forge::accounts::ApproveLoan {
            approver: lf.f.outsider.pubkey(),
            vault: lf.f.vault,
            loan: lf.loan,
        }
        .to_account_metas(None),
        data: forge::instruction::ApproveLoan {}.data(),
    };
    let outsider = lf.f.outsider.insecure_clone();
    lf.expect_custom_rollback(outsider_approve, &outsider, &[], 6004);

    lf.approve_a();
    let loan = lf.loan_state();
    assert_eq!(loan.approvals, [true, false]);
    assert_eq!(loan.state, forge::LoanState::Proposed);

    let draw = lf.draw_ix();
    let borrower = lf.borrower.insecure_clone();
    lf.expect_custom_rollback(draw, &borrower, &[], 6010);

    let duplicate = lf.approve_ix(&lf.f.approvers[0]);
    custom_error(lf.f.execute_as_approver(0, duplicate, None), 6011);
    let loan = lf.loan_state();
    assert_eq!(loan.approvals, [true, false]);
    assert_eq!(loan.state, forge::LoanState::Proposed);

    lf.approve_b();
    let loan = lf.loan_state();
    assert_eq!(loan.approvals, [true, true]);
    assert_eq!(loan.state, forge::LoanState::Approved);
    assert_eq!(
        (
            loan.borrower,
            loan.destination,
            loan.principal,
            loan.term_rate_bps,
            loan.fixed_interest,
            loan.fixed_payoff,
            loan.term_seconds,
            loan.offer_expiry,
        ),
        immutable_terms
    );
}

#[test]
fn draw_loan_rejects_expiry_pause_liquidity_and_account_substitution() {
    let mut lf = LoanFixture::new();
    lf.propose_default();
    lf.approve_both();

    let mut wrong_borrower = lf.draw_ix();
    wrong_borrower.accounts[0].pubkey = lf.f.outsider.pubkey();
    let outsider = lf.f.outsider.insecure_clone();
    lf.expect_custom_rollback(wrong_borrower, &outsider, &[], 6006 + 10);

    let before_expiry_state = lf.loan_state();
    lf.set_time(before_expiry_state.offer_expiry + 1);
    assert_eq!(lf.loan_state(), before_expiry_state);
    let borrower = lf.borrower.insecure_clone();
    lf.expect_custom_rollback(lf.draw_ix(), &borrower, &[], 6013);
    lf.set_time(before_expiry_state.offer_expiry - 1);

    let pause = lf.pause_ix(true);
    lf.f.execute_as_approver(0, pause, Some(1)).unwrap();
    let borrower = lf.borrower.insecure_clone();
    lf.expect_custom_rollback(lf.draw_ix(), &borrower, &[], 6012);
    let unpause = lf.pause_ix(false);
    lf.f.execute_as_approver(0, unpause, Some(1)).unwrap();

    let mut underfunded = LoanFixture::new();
    underfunded.propose_default();
    underfunded.approve_both();
    underfunded.withdraw([5; 32], FUNDING).unwrap();
    let borrower = underfunded.borrower.insecure_clone();
    underfunded.expect_custom_rollback(underfunded.draw_ix(), &borrower, &[], 6015);

    let other_mint = create_mint(&mut lf.f.svm, &lf.f.treasury, 6);
    let other_destination = create_token_account(
        &mut lf.f.svm,
        &lf.f.treasury,
        lf.f.mint,
        lf.f.outsider.pubkey(),
    );
    let mut wrong_destination = lf.draw_ix();
    wrong_destination.accounts[5].pubkey = other_destination;
    let borrower = lf.borrower.insecure_clone();
    lf.expect_custom_rollback(wrong_destination, &borrower, &[], 6017);

    let mut wrong_mint = lf.draw_ix();
    wrong_mint.accounts[3].pubkey = other_mint;
    let borrower = lf.borrower.insecure_clone();
    lf.expect_custom_rollback(wrong_mint, &borrower, &[], 2001);

    for program in [system_program::ID, anchor_spl::token_2022::ID] {
        let mut wrong_program = lf.draw_ix();
        wrong_program.accounts[6].pubkey = program;
        let borrower = lf.borrower.insecure_clone();
        lf.expect_custom_rollback(wrong_program, &borrower, &[], 3008);
    }
}

#[test]
fn draw_loan_rejects_outstanding_limit_cross_vault_and_executes_once() {
    let mut lf = LoanFixture::new();
    lf.propose_default();
    lf.approve_both();

    let tight_id = [50; 32];
    let tight_vault = anchor_lang::prelude::Pubkey::find_program_address(
        &[b"vault", lf.f.treasury.pubkey().as_ref(), &tight_id],
        &forge::ID,
    )
    .0;
    let tight_tokens = anchor_lang::prelude::Pubkey::find_program_address(
        &[b"tokens", tight_vault.as_ref()],
        &forge::ID,
    )
    .0;
    let tight_create = custom_create_ix(
        &lf.f,
        tight_id,
        tight_vault,
        tight_tokens,
        PRINCIPAL,
        PRINCIPAL,
    );
    lf.f.execute(tight_create).unwrap();
    let tight_loan_id = [51; 32];
    let tight_loan = loan_pda(tight_vault, tight_loan_id);
    let tight_destination = create_token_account(
        &mut lf.f.svm,
        &lf.f.treasury,
        lf.f.mint,
        lf.borrower.pubkey(),
    );
    let mut propose_tight = lf.propose_ix(
        lf.f.approvers[0].pubkey(),
        tight_loan_id,
        tight_loan,
        PRINCIPAL,
        RATE_BPS,
        TERM_SECONDS,
        lf.now() + 1_000,
    );
    propose_tight.accounts[1].pubkey = tight_vault;
    propose_tight.accounts[4].pubkey = tight_destination;
    lf.f.execute_as_approver(0, propose_tight, None).unwrap();
    for approver_i in 0..2 {
        let approve = Instruction {
            program_id: forge::ID,
            accounts: forge::accounts::ApproveLoan {
                approver: lf.f.approvers[approver_i].pubkey(),
                vault: tight_vault,
                loan: tight_loan,
            }
            .to_account_metas(None),
            data: forge::instruction::ApproveLoan {}.data(),
        };
        lf.f.execute_as_approver(approver_i, approve, None).unwrap();
    }
    lf.mint_to_source(PRINCIPAL);
    let fund_tight = Instruction {
        program_id: forge::ID,
        accounts: forge::accounts::FundVault {
            treasury: lf.f.treasury.pubkey(),
            vault: tight_vault,
            mint: lf.f.mint,
            source: lf.f.source,
            vault_token_account: tight_tokens,
            token_program: spl_token::ID,
        }
        .to_account_metas(None),
        data: forge::instruction::FundVault { amount: PRINCIPAL }.data(),
    };
    lf.f.execute(fund_tight).unwrap();
    let tight_draw = Instruction {
        program_id: forge::ID,
        accounts: forge::accounts::DrawLoan {
            borrower: lf.borrower.pubkey(),
            vault: tight_vault,
            loan: tight_loan,
            mint: lf.f.mint,
            vault_token_account: tight_tokens,
            destination: tight_destination,
            token_program: spl_token::ID,
        }
        .to_account_metas(None),
        data: forge::instruction::DrawLoan {}.data(),
    };
    lf.f.execute_as(&lf.borrower, tight_draw, &[]).unwrap();

    let second_tight_id = [52; 32];
    let second_tight_loan = loan_pda(tight_vault, second_tight_id);
    let second_tight_destination = create_token_account(
        &mut lf.f.svm,
        &lf.f.treasury,
        lf.f.mint,
        lf.borrower.pubkey(),
    );
    let mut second_tight_propose = lf.propose_ix(
        lf.f.approvers[0].pubkey(),
        second_tight_id,
        second_tight_loan,
        PRINCIPAL,
        RATE_BPS,
        TERM_SECONDS,
        lf.now() + 1_000,
    );
    second_tight_propose.accounts[1].pubkey = tight_vault;
    second_tight_propose.accounts[4].pubkey = second_tight_destination;
    lf.f.execute_as_approver(0, second_tight_propose, None)
        .unwrap();
    for approver_i in 0..2 {
        let approve = Instruction {
            program_id: forge::ID,
            accounts: forge::accounts::ApproveLoan {
                approver: lf.f.approvers[approver_i].pubkey(),
                vault: tight_vault,
                loan: second_tight_loan,
            }
            .to_account_metas(None),
            data: forge::instruction::ApproveLoan {}.data(),
        };
        lf.f.execute_as_approver(approver_i, approve, None).unwrap();
    }
    let second_tight_draw = Instruction {
        program_id: forge::ID,
        accounts: forge::accounts::DrawLoan {
            borrower: lf.borrower.pubkey(),
            vault: tight_vault,
            loan: second_tight_loan,
            mint: lf.f.mint,
            vault_token_account: tight_tokens,
            destination: second_tight_destination,
            token_program: spl_token::ID,
        }
        .to_account_metas(None),
        data: forge::instruction::DrawLoan {}.data(),
    };
    custom_error(lf.f.execute_as(&lf.borrower, second_tight_draw, &[]), 6014);

    let mut cross_vault = lf.draw_ix();
    cross_vault.accounts[1].pubkey = tight_vault;
    custom_error(lf.f.execute_as(&lf.borrower, cross_vault, &[]), 2006);

    let before = lf.balances();
    lf.f.execute_as(&lf.borrower, lf.draw_ix(), &[]).unwrap();
    assert_eq!(lf.f.balance(lf.f.tokens), before.0 - PRINCIPAL);
    assert_eq!(lf.f.balance(lf.destination), before.1 + PRINCIPAL);
    assert_eq!(lf.vault_state().outstanding_principal, before.2 + PRINCIPAL);
    assert_eq!(lf.loan_state().state, forge::LoanState::Active);

    let before_second = lf.balances();
    custom_error(lf.f.execute_as(&lf.borrower, lf.draw_ix(), &[]), 6010);
    assert_eq!(lf.balances(), before_second);
}

#[test]
fn repay_loan_rejects_substitutions_and_executes_once_after_pause_and_maturity() {
    let mut lf = LoanFixture::new();
    lf.propose_default();
    lf.approve_both();
    lf.mint_to_destination(PAYOFF - PRINCIPAL);
    lf.f.execute_as(&lf.borrower, lf.draw_ix(), &[]).unwrap();

    let pause = lf.pause_ix(true);
    lf.f.execute_as_approver(0, pause, Some(1)).unwrap();
    let active = lf.loan_state();
    lf.set_time(active.disbursed_at + active.term_seconds + 1);
    assert_eq!(lf.loan_state(), active);

    let mut wrong_borrower = lf.repay_ix();
    wrong_borrower.accounts[0].pubkey = lf.f.outsider.pubkey();
    let outsider = lf.f.outsider.insecure_clone();
    custom_error(lf.f.execute_as(&outsider, wrong_borrower, &[]), 6006 + 10);

    let mut wrong_source = lf.repay_ix();
    wrong_source.accounts[4].pubkey = lf.f.source;
    custom_error(lf.f.execute_as(&lf.borrower, wrong_source, &[]), 2015);

    let other_mint = create_mint(&mut lf.f.svm, &lf.f.treasury, 6);
    let mut wrong_mint = lf.repay_ix();
    wrong_mint.accounts[3].pubkey = other_mint;
    custom_error(lf.f.execute_as(&lf.borrower, wrong_mint, &[]), 2001);

    let before_repay = lf.balances();
    lf.f.execute_as(&lf.borrower, lf.repay_ix(), &[]).unwrap();
    assert_eq!(lf.f.balance(lf.f.tokens), before_repay.0 + PAYOFF);
    assert_eq!(lf.f.balance(lf.destination), before_repay.1 - PAYOFF);
    assert_eq!(lf.vault_state().outstanding_principal, 0);
    assert_eq!(lf.loan_state().state, forge::LoanState::Repaid);

    let before_second = lf.balances();
    custom_error(lf.f.execute_as(&lf.borrower, lf.repay_ix(), &[]), 6010);
    assert_eq!(lf.balances(), before_second);
}

#[test]
fn withdrawal_and_pause_require_both_approvers_and_fixed_destination() {
    let mut lf = LoanFixture::new();

    let mut missing_second = lf.pause_ix(true);
    missing_second.accounts[1].is_signer = false;
    custom_error(lf.f.execute_as_approver(0, missing_second, None), 3010);

    let mut duplicate = lf.pause_ix(true);
    duplicate.accounts[1].pubkey = lf.f.approvers[0].pubkey();
    custom_error(lf.f.execute_as_approver(0, duplicate, None), 6000);

    let mut outsider = lf.pause_ix(true);
    outsider.accounts[1].pubkey = lf.f.outsider.pubkey();
    let approver_a = lf.f.approvers[0].insecure_clone();
    let outsider_signer = lf.f.outsider.insecure_clone();
    custom_error(
        lf.f.execute_as(&approver_a, outsider, &[&outsider_signer]),
        6004,
    );

    let pause = lf.pause_ix(true);
    lf.f.execute_as_approver(0, pause, Some(1)).unwrap();

    lf.mint_to_source(1);
    lf.f.execute(lf.f.fund(1)).unwrap();
    let approver_a = lf.f.approvers[0].insecure_clone();
    let approver_b = lf.f.approvers[1].insecure_clone();
    let first = [21; 32];

    let outsider_proposal = lf.propose_withdrawal_ix(&outsider_signer, first, 1);
    custom_error(
        lf.f.execute_as(&outsider_signer, outsider_proposal, &[]),
        6004,
    );
    let zero = lf.propose_withdrawal_ix(&approver_a, first, 0);
    custom_error(lf.f.execute_as(&approver_a, zero, &[]), 6003);

    let propose = lf.propose_withdrawal_ix(&approver_a, first, 1);
    lf.f.execute_as(&approver_a, propose, &[]).unwrap();
    let proposed = lf.withdrawal_state(first);
    assert_eq!(proposed.approvals, [true, false]);
    assert_eq!(proposed.state, forge::WithdrawalState::Proposed);

    let self_approval = lf.approve_withdrawal_ix(&approver_a, first);
    custom_error(lf.f.execute_as(&approver_a, self_approval, &[]), 6011);
    let outsider_approval = lf.approve_withdrawal_ix(&outsider_signer, first);
    custom_error(
        lf.f.execute_as(&outsider_signer, outsider_approval, &[]),
        6004,
    );

    let other_destination = create_token_account(
        &mut lf.f.svm,
        &lf.f.treasury,
        lf.f.mint,
        lf.f.treasury.pubkey(),
    );
    let mut wrong_destination = lf.approve_withdrawal_ix(&approver_b, first);
    wrong_destination.accounts[5].pubkey = other_destination;
    custom_error(lf.f.execute_as(&approver_b, wrong_destination, &[]), 2012);

    let before = (lf.f.balance(lf.f.tokens), lf.f.balance(lf.f.source));
    let approve = lf.approve_withdrawal_ix(&approver_b, first);
    lf.f.execute_as(&approver_b, approve, &[]).unwrap();
    assert_eq!(
        (lf.f.balance(lf.f.tokens), lf.f.balance(lf.f.source)),
        (before.0 - 1, before.1 + 1)
    );
    assert_eq!(
        lf.withdrawal_state(first).state,
        forge::WithdrawalState::Executed
    );

    // Replays of either step fail without moving funds again.
    let after = (lf.f.balance(lf.f.tokens), lf.f.balance(lf.f.source));
    let replay_approval = lf.approve_withdrawal_ix(&approver_b, first);
    custom_error(lf.f.execute_as(&approver_b, replay_approval, &[]), 6018);
    let replay_proposal = lf.propose_withdrawal_ix(&approver_a, first, 1);
    custom_error(lf.f.execute_as(&approver_a, replay_proposal, &[]), 0);
    assert_eq!(
        (lf.f.balance(lf.f.tokens), lf.f.balance(lf.f.source)),
        after
    );

    let oversized = [22; 32];
    let propose = lf.propose_withdrawal_ix(&approver_a, oversized, FUNDING + 2);
    lf.f.execute_as(&approver_a, propose, &[]).unwrap();
    let approve = lf.approve_withdrawal_ix(&approver_b, oversized);
    custom_error(lf.f.execute_as(&approver_b, approve, &[]), 6015);

    lf.propose_default();
    lf.approve_both();
    lf.mint_to_destination(PAYOFF - PRINCIPAL);
    let unpause = lf.pause_ix(false);
    lf.f.execute_as_approver(0, unpause, Some(1)).unwrap();
    lf.f.execute_as(&lf.borrower, lf.draw_ix(), &[]).unwrap();

    // Liquidity is rechecked at approval: receivables do not count as cash.
    let cash = lf.f.balance(lf.f.tokens);
    let beyond_cash = [23; 32];
    let propose = lf.propose_withdrawal_ix(&approver_b, beyond_cash, cash + 1);
    lf.f.execute_as(&approver_b, propose, &[]).unwrap();
    let approve = lf.approve_withdrawal_ix(&approver_a, beyond_cash);
    custom_error(lf.f.execute_as(&approver_a, approve, &[]), 6015);
    lf.f.execute_as(&lf.borrower, lf.repay_ix(), &[]).unwrap();
    let approve = lf.approve_withdrawal_ix(&approver_a, beyond_cash);
    lf.f.execute_as(&approver_a, approve, &[]).unwrap();
    assert_eq!(lf.f.balance(lf.f.tokens), cash + PAYOFF - (cash + 1));
}

#[test]
fn pause_rejects_stale_sequence() {
    let mut lf = LoanFixture::new();
    let stale_unpause = lf.pause_ix(false);
    let pause = lf.pause_ix(true);
    lf.f.execute_as_approver(0, pause, Some(1)).unwrap();
    let paused = lf.vault_state();
    assert!(paused.disbursement_paused);
    assert_eq!(paused.pause_seq, 1);

    // A request signed before the newer pause cannot undo it.
    custom_error(lf.f.execute_as_approver(0, stale_unpause, Some(1)), 6019);
    assert_eq!(lf.vault_state(), paused);

    let unpause = lf.pause_ix(false);
    lf.f.execute_as_approver(0, unpause, Some(1)).unwrap();
    let resumed = lf.vault_state();
    assert!(!resumed.disbursement_paused);
    assert_eq!(resumed.pause_seq, 2);
}
