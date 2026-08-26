# Minato

Minato is a Sui Move package and TypeScript SDK for deterministic fungible-token distributions. It supports distributions from an existing `Balance<C>` or from address-balance funds represented by `Withdrawal<Balance<C>>`.

## Components

- [`move/`](./move) provides `disperse`, which applies one encoded payout chunk to a balance, and `disperse_withdrawal`, which redeems and distributes a withdrawal across one to eight chunks.
- [`sdk/`](./sdk) provides the `@unconfirmedlabs/minato` codec, offline planner, plan verifier, transaction builders, and Sui client extension.

Payout amounts use a canonical ULEB128 run encoding while recipients remain native Sui addresses. The planner sorts and validates payouts, observes pure-input and signed-transaction limits, calculates exact BCS sizes, and produces JSON-safe plans with distribution, batch, and plan hashes.

`disperse` may leave a remainder in the caller's balance. `disperse_withdrawal` requires the withdrawal total to equal the encoded payouts.

The SDK does not query RPC, select gas objects, sign or execute transactions, parse source files, or manage retries and execution progress. It has no default deployment; callers provide the ID of a compatible published package.

## Install

```sh
npm install @unconfirmedlabs/minato @mysten/sui
```

## Usage

```ts
import {
  createDistributionPlan,
  createMinatoTx,
  verifyDistributionPlan,
} from "@unconfirmedlabs/minato";

const plan = createDistributionPlan({
  packageId: "0x...",
  source: "0x...",
  coinType: "0x2::sui::SUI",
  payouts: [{ recipient: "0x...", amount: 100n }],
  limits: {
    maxSignedTransactionBytes: 131_072,
    maxPureArgumentBytes: 16_384,
    gasPaymentCount: 1,
    signatureLengths: [97],
  },
});

verifyDistributionPlan(plan);

const transaction = createMinatoTx(plan.packageId).disperseWithdrawal({
  batch: plan.batches[0],
});
```

The transaction builder leaves gas data unset. A wallet, sponsor, or execution service must supply gas and execute each planned batch.

## Reference

- [SDK usage](./sdk/README.md)
- [Codec v1](./sdk/docs/codec-v1.md)
- [Plan and hash format v1](./sdk/docs/plan-v1.md)
- [Golden vectors](./sdk/golden/v1.json)
- [Planner performance](./sdk/docs/performance.md)

## Development

```sh
(cd move && sui move test)
(cd sdk && bun install && bun run golden:check && bun run typecheck && bun run test && bun run build)
```

## License

MIT
