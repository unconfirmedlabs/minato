#[test_only]
module minato::minato_tests;

use std::unit_test::assert_eq;
use minato::minato;
use sui::balance;
use sui::sui::SUI;

#[test]
fun single_group_distributes_full_balance() {
    let mut balance = balance::create_for_testing<SUI>(300);
    minato::disperse(&mut balance, vector[@0x1, @0x2, @0x3], vector[1, 100, 3]);
    assert_eq!(balance.value(), 0);
    balance.destroy_for_testing();
}

#[test]
fun multiple_groups_use_positive_deltas() {
    let mut balance = balance::create_for_testing<SUI>(258);
    // Two recipients receive 1, then two receive 128 (delta 127).
    minato::disperse(&mut balance, vector[@0x1, @0x2, @0x3, @0x4], vector[2, 1, 2, 127, 2]);
    assert_eq!(balance.value(), 0);
    balance.destroy_for_testing();
}

#[test]
fun multi_byte_values_are_supported() {
    let mut balance = balance::create_for_testing<SUI>(128);
    minato::disperse(&mut balance, vector[@0x1], vector[1, 0x80, 0x01, 1]);
    assert_eq!(balance.value(), 0);
    balance.destroy_for_testing();
}

#[test]
fun multi_byte_run_count_is_supported() {
    let mut recipients = vector[];
    128u64.do!(|_| recipients.push_back(@0x1));
    let mut balance = balance::create_for_testing<SUI>(128);
    minato::disperse(&mut balance, recipients, vector[1, 1, 0x80, 0x01]);
    assert_eq!(balance.value(), 0);
    balance.destroy_for_testing();
}

#[test]
fun multi_byte_group_count_is_supported() {
    let mut recipients = vector[];
    let mut runs = vector[0x80, 0x01];
    128u64.do!(|_| {
        recipients.push_back(@0x1);
        runs.push_back(1);
        runs.push_back(1);
    });
    let mut balance = balance::create_for_testing<SUI>(8256);
    minato::disperse(&mut balance, recipients, runs);
    assert_eq!(balance.value(), 0);
    balance.destroy_for_testing();
}

#[test]
fun partial_disperse_keeps_remainder() {
    let mut balance = balance::create_for_testing<SUI>(500);
    minato::disperse(&mut balance, vector[@0x1, @0x2], vector[1, 100, 2]);
    assert_eq!(balance.value(), 300);
    balance.destroy_for_testing();
}

#[test, expected_failure]
fun empty_chunk_aborts() {
    minato::disperse_for_testing(balance::create_for_testing<SUI>(0), vector[], vector[]);
}

#[test, expected_failure]
fun zero_group_count_aborts() {
    minato::disperse_for_testing(balance::create_for_testing<SUI>(1), vector[@0x1], vector[0]);
}

#[test, expected_failure]
fun zero_amount_delta_aborts() {
    minato::disperse_for_testing(balance::create_for_testing<SUI>(1), vector[@0x1], vector[1, 0, 1]);
}

#[test, expected_failure]
fun zero_run_length_aborts() {
    minato::disperse_for_testing(balance::create_for_testing<SUI>(1), vector[@0x1], vector[1, 1, 0]);
}

#[test, expected_failure]
fun noncanonical_uleb128_aborts() {
    minato::disperse_for_testing(
        balance::create_for_testing<SUI>(1),
        vector[@0x1],
        vector[1, 0x81, 0x00, 1],
    );
}

#[test, expected_failure]
fun u64_overflow_aborts() {
    minato::disperse_for_testing(
        balance::create_for_testing<SUI>(0xffff_ffff_ffff_ffff),
        vector[@0x1, @0x2],
        vector[
            2,
            0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01,
            1,
            1,
            1,
        ],
    );
}

#[test, expected_failure]
fun uleb128_value_above_u64_aborts() {
    minato::disperse_for_testing(
        balance::create_for_testing<SUI>(0xffff_ffff_ffff_ffff),
        vector[@0x1],
        vector[
            1,
            0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x02,
            1,
        ],
    );
}

#[test, expected_failure]
fun uleb128_continuation_after_tenth_byte_aborts() {
    minato::disperse_for_testing(
        balance::create_for_testing<SUI>(1),
        vector[@0x1],
        vector[
            1,
            0x81, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80,
            1,
        ],
    );
}

#[test, expected_failure]
fun run_count_cannot_exceed_remaining_recipients() {
    minato::disperse_for_testing(
        balance::create_for_testing<SUI>(2),
        vector[@0x1],
        vector[1, 1, 2],
    );
}

#[test, expected_failure]
fun truncated_runs_abort() {
    minato::disperse_for_testing(balance::create_for_testing<SUI>(1), vector[@0x1], vector[1, 1]);
}

#[test, expected_failure]
fun trailing_bytes_abort() {
    minato::disperse_for_testing(
        balance::create_for_testing<SUI>(1),
        vector[@0x1],
        vector[1, 1, 1, 0],
    );
}

#[test, expected_failure]
fun run_counts_must_consume_all_recipients() {
    minato::disperse_for_testing(
        balance::create_for_testing<SUI>(2),
        vector[@0x1, @0x2],
        vector[1, 1, 1],
    );
}

#[test]
fun paired_trailing_padding_is_valid() {
    minato::validate_padding_for_testing(
        &vector[@0x1],
        &vector[1, 1, 1],
        &vector[],
        &vector[],
        &vector[],
        &vector[],
    );
}

#[test, expected_failure]
fun one_sided_padding_aborts() {
    minato::validate_padding_for_testing(
        &vector[@0x1],
        &vector[1, 1, 1],
        &vector[],
        &vector[1],
        &vector[],
        &vector[],
    );
}

#[test, expected_failure]
fun nonempty_chunk_after_padding_aborts() {
    minato::validate_padding_for_testing(
        &vector[@0x1],
        &vector[1, 1, 1],
        &vector[],
        &vector[],
        &vector[@0x2],
        &vector[1, 1, 1],
    );
}
