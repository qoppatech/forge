mod support;

use anchor_lang::solana_program::instruction::Instruction;
use anchor_lang::{
    prelude::Pubkey, solana_program::system_program, InstructionData, ToAccountMetas,
};
use anchor_spl::token::spl_token::{self, instruction as token_instruction};
use solana_keypair::Keypair;
use solana_signer::Signer;

use support::*;

#[test]
fn loan_lifecycle_requires_approvals_and_closes_once() {
    let mut f = Fixture::new();
    f.initialize();
    f.svm
        .airdrop(&f.approvers[0].pubkey(), 1_000_000_000)
        .unwrap();
    f.svm
        .airdrop(&f.approvers[1].pubkey(), 1_000_000_000)
        .unwrap();

    let borrower = Keypair::new();
    f.svm.airdrop(&borrower.pubkey(), 1_000_000_000).unwrap();
    let destination = create_token_account(&mut f.svm, &f.treasury, f.mint, borrower.pubkey());
    send(
        &mut f.svm,
        &f.treasury,
        &[token_instruction::mint_to_checked(
            &spl_token::ID,
            &f.mint,
            &destination,
            &f.treasury.pubkey(),
            &[],
            100_000_000,
            6,
        )
        .unwrap()],
        &[],
    )
    .unwrap();
    f.execute(f.fund(FUNDING)).unwrap();

    let loan_id = [7; 32];
    let loan = Pubkey::find_program_address(&[b"loan", f.vault.as_ref(), &loan_id], &forge::ID).0;
    let propose = Instruction {
        program_id: forge::ID,
        accounts: forge::accounts::ProposeLoan {
            approver: f.approvers[0].pubkey(),
            vault: f.vault,
            loan,
            borrower: borrower.pubkey(),
            destination,
            mint: f.mint,
            system_program: system_program::ID,
        }
        .to_account_metas(None),
        data: forge::instruction::ProposeLoan {
            loan_id,
            principal: 5_000_000_000,
            term_rate_bps: 200,
            term_seconds: 30 * 24 * 60 * 60,
            offer_expiry: i64::MAX,
        }
        .data(),
    };
    f.execute_as_approver(0, propose, None).unwrap();

    let vault = f.vault;
    let approve = |approver: &Keypair| Instruction {
        program_id: forge::ID,
        accounts: forge::accounts::ApproveLoan {
            approver: approver.pubkey(),
            vault,
            loan,
        }
        .to_account_metas(None),
        data: forge::instruction::ApproveLoan {}.data(),
    };
    let approve_a = approve(&f.approvers[0]);
    f.execute_as_approver(0, approve_a, None).unwrap();
    let approve_b = approve(&f.approvers[1]);
    f.execute_as_approver(1, approve_b, None).unwrap();

    let draw = Instruction {
        program_id: forge::ID,
        accounts: forge::accounts::DrawLoan {
            borrower: borrower.pubkey(),
            vault: f.vault,
            loan,
            mint: f.mint,
            vault_token_account: f.tokens,
            destination,
            token_program: spl_token::ID,
        }
        .to_account_metas(None),
        data: forge::instruction::DrawLoan {}.data(),
    };
    f.execute_as(&borrower, draw, &[]).unwrap();
    assert_eq!(f.balance(f.tokens), FUNDING - 5_000_000_000);
    assert_eq!(f.balance(destination), 5_100_000_000);

    let repay = Instruction {
        program_id: forge::ID,
        accounts: forge::accounts::RepayLoan {
            borrower: borrower.pubkey(),
            vault: f.vault,
            loan,
            mint: f.mint,
            borrower_tokens: destination,
            vault_token_account: f.tokens,
            token_program: spl_token::ID,
        }
        .to_account_metas(None),
        data: forge::instruction::RepayLoan {}.data(),
    };
    f.execute_as(&borrower, repay, &[]).unwrap();
    assert_eq!(f.balance(f.tokens), FUNDING + 100_000_000);
    assert_eq!(f.balance(destination), 0);

    let pause = Instruction {
        program_id: forge::ID,
        accounts: forge::accounts::SetDisbursementPaused {
            approver_a: f.approvers[0].pubkey(),
            approver_b: f.approvers[1].pubkey(),
            vault: f.vault,
        }
        .to_account_metas(None),
        data: forge::instruction::SetDisbursementPaused {
            paused: true,
            expected_seq: 0,
        }
        .data(),
    };
    f.execute_as_approver(0, pause, Some(1)).unwrap();

    let withdrawal_id = [8; 32];
    let withdrawal = Pubkey::find_program_address(
        &[b"withdrawal", f.vault.as_ref(), &withdrawal_id],
        &forge::ID,
    )
    .0;
    let propose_withdrawal = Instruction {
        program_id: forge::ID,
        accounts: forge::accounts::ProposeWithdrawal {
            approver: f.approvers[0].pubkey(),
            vault: f.vault,
            withdrawal,
            system_program: system_program::ID,
        }
        .to_account_metas(None),
        data: forge::instruction::ProposeWithdrawal {
            withdrawal_id,
            amount: 100_000_000,
        }
        .data(),
    };
    f.execute_as_approver(0, propose_withdrawal, None).unwrap();
    assert_eq!(f.balance(f.tokens), FUNDING + 100_000_000);

    let approve_withdrawal = Instruction {
        program_id: forge::ID,
        accounts: forge::accounts::ApproveWithdrawal {
            approver: f.approvers[1].pubkey(),
            vault: f.vault,
            withdrawal,
            mint: f.mint,
            vault_token_account: f.tokens,
            treasury_destination: f.source,
            token_program: spl_token::ID,
        }
        .to_account_metas(None),
        data: forge::instruction::ApproveWithdrawal {}.data(),
    };
    f.execute_as_approver(1, approve_withdrawal, None).unwrap();
    assert_eq!(f.balance(f.tokens), FUNDING);
    assert_eq!(f.balance(f.source), 100_000_000);
}
