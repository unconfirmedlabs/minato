module minato::minato;

use std::vector::zip_do;
use sui::balance::Balance;
use sui::coin::Coin;

//=== Errors ===

const ELengthMismatch: u64 = 0;

//=== Public Functions ===

/// Disperse a balance to multiple recipients.
public fun disperse_balance<C>(
    balance: &mut Balance<C>,
    amounts: vector<u64>,
    recipients: vector<address>,
) {
    disperse_balance_impl(balance, amounts, recipients);
}

/// Disperse a coin to multiple recipients.
public fun disperse_coin<C>(coin: &mut Coin<C>, amounts: vector<u64>, recipients: vector<address>) {
    disperse_balance_impl(coin.balance_mut(), amounts, recipients);
}

/// Implementation of disperse_balance and disperse_coin.
fun disperse_balance_impl<C>(
    balance: &mut Balance<C>,
    amounts: vector<u64>,
    recipients: vector<address>,
) {
    assert!(amounts.length() == recipients.length(), ELengthMismatch);

    zip_do!(amounts, recipients, |amount, recipient| {
        balance.split(amount).send_funds(recipient);
    });
}
