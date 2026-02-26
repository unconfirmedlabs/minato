# Minato

Batch token dispersal on Sui. Send coins or balances to many recipients in a single transaction.

## Overview

Minato provides two public functions for dispersing funds:

- **`disperse_balance<C>`** — Split a `Balance<C>` across multiple recipients.
- **`disperse_coin<C>`** — Split a `Coin<C>` across multiple recipients.

Both accept a vector of amounts and a vector of recipient addresses. The amounts and recipients are matched by index — `amounts[0]` goes to `recipients[0]`, and so on.

Partial dispersals are supported. If the sum of amounts is less than the total balance, the remainder stays in the original balance/coin.

## Usage

```move
use minato::minato;

// Disperse a coin
minato::disperse_coin(&mut coin, vector[100, 200, 300], vector[@0x1, @0x2, @0x3]);

// Disperse a balance
minato::disperse_balance(&mut balance, vector[100, 200, 300], vector[@0x1, @0x2, @0x3]);
```

## Deployments

| Network | Package ID |
|---------|-----------|
| Testnet | `0x8466e9864c1d947888e73b0e349b035bc22805579eef18f132966f56c8efe1d2` |

## Build & Test

```sh
sui move build
sui move test
```

## License

MIT
