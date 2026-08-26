module minato::minato;

use sui::balance::{Self, Balance};
use sui::funds_accumulator::Withdrawal;

#[error(code = 0)]
const EEmptyChunk: vector<u8> = b"A distribution chunk must not be empty";

#[error(code = 1)]
const EInvalidRuns: vector<u8> = b"The run encoding is invalid or non-canonical";

#[error(code = 2)]
const EInvalidPadding: vector<u8> = b"Withdrawal chunks must use paired trailing empty padding";

#[error(code = 3)]
const ENoChunks: vector<u8> = b"A withdrawal distribution must contain at least one chunk";

/// Disperse a balance according to Minato codec v1.
///
/// `runs` is `group_count` followed by `(amount_delta, recipient_count)`
/// pairs, all encoded as canonical unsigned LEB128 values. Recipients are
/// consumed in order. Amount deltas and run lengths must be positive.
public fun disperse<C>(
    balance: &mut Balance<C>,
    recipients: vector<address>,
    runs: vector<u8>,
) {
    assert!(!recipients.is_empty() && !runs.is_empty(), EEmptyChunk);

    let mut cursor = 0;
    let group_count = read_uleb128(&runs, &mut cursor);
    assert!(group_count > 0, EInvalidRuns);

    let mut recipient_index = 0;
    let mut amount = 0;
    group_count.do!(|_| {
        let delta = read_uleb128(&runs, &mut cursor);
        let recipient_count = read_uleb128(&runs, &mut cursor);
        assert!(delta > 0 && recipient_count > 0, EInvalidRuns);
        assert!(amount <= std::u64::max_value!() - delta, EInvalidRuns);
        assert!(recipient_count <= recipients.length() - recipient_index, EInvalidRuns);

        amount = amount + delta;
        recipient_count.do!(|_| {
            balance.split(amount).send_funds(recipients[recipient_index]);
            recipient_index = recipient_index + 1;
        });
    });

    assert!(recipient_index == recipients.length(), EInvalidRuns);
    assert!(cursor == runs.length(), EInvalidRuns);
}

/// Redeem address balance funds and disperse them across one to eight chunks.
///
/// The fixed arity keeps the ABI stable. Unused pairs must be supplied as
/// paired empty vectors after all non-empty chunks.
public fun disperse_withdrawal<C>(
    withdrawal: Withdrawal<Balance<C>>,
    recipients_1: vector<address>,
    runs_1: vector<u8>,
    recipients_2: vector<address>,
    runs_2: vector<u8>,
    recipients_3: vector<address>,
    runs_3: vector<u8>,
    recipients_4: vector<address>,
    runs_4: vector<u8>,
    recipients_5: vector<address>,
    runs_5: vector<u8>,
    recipients_6: vector<address>,
    runs_6: vector<u8>,
    recipients_7: vector<address>,
    runs_7: vector<u8>,
    recipients_8: vector<address>,
    runs_8: vector<u8>,
) {
    let mut padding_started = false;
    assert!(!recipients_1.is_empty() && !runs_1.is_empty(), ENoChunks);
    validate_pair(&recipients_1, &runs_1, &mut padding_started);
    validate_pair(&recipients_2, &runs_2, &mut padding_started);
    validate_pair(&recipients_3, &runs_3, &mut padding_started);
    validate_pair(&recipients_4, &runs_4, &mut padding_started);
    validate_pair(&recipients_5, &runs_5, &mut padding_started);
    validate_pair(&recipients_6, &runs_6, &mut padding_started);
    validate_pair(&recipients_7, &runs_7, &mut padding_started);
    validate_pair(&recipients_8, &runs_8, &mut padding_started);

    let mut balance = balance::redeem_funds(withdrawal);
    disperse(&mut balance, recipients_1, runs_1);
    disperse_if_present(&mut balance, recipients_2, runs_2);
    disperse_if_present(&mut balance, recipients_3, runs_3);
    disperse_if_present(&mut balance, recipients_4, runs_4);
    disperse_if_present(&mut balance, recipients_5, runs_5);
    disperse_if_present(&mut balance, recipients_6, runs_6);
    disperse_if_present(&mut balance, recipients_7, runs_7);
    disperse_if_present(&mut balance, recipients_8, runs_8);
    balance.destroy_zero();
}

fun disperse_if_present<C>(
    balance: &mut Balance<C>,
    recipients: vector<address>,
    runs: vector<u8>,
) {
    if (recipients.is_empty()) {
        recipients.destroy_empty();
        runs.destroy_empty();
    } else {
        disperse(balance, recipients, runs);
    };
}

fun validate_pair(
    recipients: &vector<address>,
    runs: &vector<u8>,
    padding_started: &mut bool,
) {
    let recipients_empty = recipients.is_empty();
    let runs_empty = runs.is_empty();
    assert!(recipients_empty == runs_empty, EInvalidPadding);
    if (recipients_empty) {
        *padding_started = true;
    } else {
        assert!(!*padding_started, EInvalidPadding);
    };
}

/// Decode one canonical u64 ULEB128 value.
fun read_uleb128(bytes: &vector<u8>, cursor: &mut u64): u64 {
    let mut value = 0;
    let mut shift = 0u8;
    let mut byte_count = 0u64;
    loop {
        assert!(*cursor < bytes.length() && byte_count < 10, EInvalidRuns);
        let byte = bytes[*cursor];
        *cursor = *cursor + 1;

        let payload = (byte & 0x7f) as u64;
        if (byte_count == 9) {
            assert!(payload <= 1, EInvalidRuns);
        };
        value = value | (payload << shift);
        byte_count = byte_count + 1;

        if ((byte & 0x80) == 0) {
            assert!(byte_count == 1 || payload != 0, EInvalidRuns);
            return value
        };
        assert!(byte_count < 10, EInvalidRuns);
        shift = shift + 7;
    }
}

#[test_only]
public(package) fun disperse_for_testing<C>(
    mut balance: Balance<C>,
    recipients: vector<address>,
    runs: vector<u8>,
) {
    disperse(&mut balance, recipients, runs);
    balance.destroy_for_testing();
}

#[test_only]
public(package) fun validate_padding_for_testing(
    recipients_1: &vector<address>,
    runs_1: &vector<u8>,
    recipients_2: &vector<address>,
    runs_2: &vector<u8>,
    recipients_3: &vector<address>,
    runs_3: &vector<u8>,
) {
    let mut padding_started = false;
    assert!(!recipients_1.is_empty() && !runs_1.is_empty(), ENoChunks);
    validate_pair(recipients_1, runs_1, &mut padding_started);
    validate_pair(recipients_2, runs_2, &mut padding_started);
    validate_pair(recipients_3, runs_3, &mut padding_started);
}
