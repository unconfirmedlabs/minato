#[test_only]
module minato::minato_tests;

use sui::balance;
use sui::sui::SUI;
use minato::minato;

// ============================================================================
// Helpers
// ============================================================================

fun build_vectors(n: u64): (vector<u64>, vector<address>) {
    let mut amounts = vector[];
    let mut recipients = vector[];
    let mut i = 0;
    while (i < n) {
        amounts.push_back(1);
        recipients.push_back(@0x1);
        i = i + 1;
    };
    (amounts, recipients)
}

fun run_disperse_n(n: u64) {
    let mut bal = balance::create_for_testing<SUI>(n);
    let (amounts, recipients) = build_vectors(n);
    minato::disperse_balance(&mut bal, amounts, recipients);
    assert!(bal.value() == 0);
    bal.destroy_for_testing();
}

// ============================================================================
// Correctness — disperse_balance
// ============================================================================

#[test]
fun test_single_recipient() {
    let mut bal = balance::create_for_testing<SUI>(1000);
    minato::disperse_balance(&mut bal, vector[1000], vector[@0x1]);
    assert!(bal.value() == 0);
    bal.destroy_for_testing();
}

#[test]
fun test_multiple_recipients() {
    let mut bal = balance::create_for_testing<SUI>(1000);
    minato::disperse_balance(&mut bal, vector[300, 300, 400], vector[@0x1, @0x2, @0x3]);
    assert!(bal.value() == 0);
    bal.destroy_for_testing();
}

#[test]
fun test_partial_disperse() {
    let mut bal = balance::create_for_testing<SUI>(1000);
    minato::disperse_balance(&mut bal, vector[100, 200], vector[@0x1, @0x2]);
    assert!(bal.value() == 700);
    bal.destroy_for_testing();
}

#[test]
fun test_empty_vectors() {
    let mut bal = balance::create_for_testing<SUI>(1000);
    minato::disperse_balance(&mut bal, vector[], vector[]);
    assert!(bal.value() == 1000);
    bal.destroy_for_testing();
}

#[test, expected_failure(abort_code = 0)]
fun test_length_mismatch_more_amounts() {
    let mut bal = balance::create_for_testing<SUI>(1000);
    minato::disperse_balance(&mut bal, vector[500, 500], vector[@0x1]);
    bal.destroy_for_testing();
}

#[test, expected_failure(abort_code = 0)]
fun test_length_mismatch_more_recipients() {
    let mut bal = balance::create_for_testing<SUI>(1000);
    minato::disperse_balance(&mut bal, vector[500], vector[@0x1, @0x2]);
    bal.destroy_for_testing();
}

#[test, expected_failure]
fun test_insufficient_balance() {
    let mut bal = balance::create_for_testing<SUI>(100);
    minato::disperse_balance(&mut bal, vector[50, 51], vector[@0x1, @0x2]);
    bal.destroy_for_testing();
}

// ============================================================================
// Correctness — disperse_coin
// ============================================================================

#[test]
fun test_disperse_coin() {
    let mut coin = sui::coin::mint_for_testing<SUI>(1000, &mut tx_context::dummy());
    minato::disperse_coin(&mut coin, vector[300, 700], vector[@0x1, @0x2]);
    assert!(coin.value() == 0);
    coin.burn_for_testing();
}

// ============================================================================
// Scale — vector variant
//
// Run with: sui move test --statistics --gas-limit 50000000000 test_vec_scale
// ============================================================================

#[test]
fun test_vec_scale_10() { run_disperse_n(10); }

#[test]
fun test_vec_scale_100() { run_disperse_n(100); }

#[test]
fun test_vec_scale_1000() { run_disperse_n(1000); }

#[test]
fun test_vec_scale_2000() { run_disperse_n(2000); }

#[test]
fun test_vec_scale_5000() { run_disperse_n(5000); }

#[test]
fun test_vec_scale_10000() { run_disperse_n(10000); }

#[test]
fun test_vec_scale_20000() { run_disperse_n(20000); }

#[test]
fun test_vec_scale_50000() { run_disperse_n(50000); }

#[test]
fun test_vec_scale_100000() { run_disperse_n(100000); }
