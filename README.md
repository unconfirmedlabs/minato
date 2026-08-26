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
    gasPaymentCount: 0, // address-balance gas
    signatureLengths: [97],
  },
});

verifyDistributionPlan(plan);

const transaction = createMinatoTx(plan.packageId).disperseWithdrawal({
  batch: plan.batches[0],
});
```

The transaction builder leaves gas data unset. A wallet, sponsor, or execution service must supply gas and execute each planned batch.

## Testnet benchmark

On 2026-08-26, the package was published to [Sui Testnet](https://testnet.suivision.xyz/package/0x24322ee84beea9938c492815585c5b6587607f264dcc52c00a49873a8c3e2d37) and used to send 1 MIST to 100,000 deterministic addresses. Gas was paid from address balance with an empty gas-payment vector.

| Metric | Result |
| --- | ---: |
| Successful transactions | 25 / 25 |
| Recipients per full transaction | 4,078 |
| Largest signed transaction | 131,047 / 131,072 bytes |
| Executed computation | 7,180,900 gas units |
| Cost at Testnet RGP (1,000 MIST) | 7.1809 SUI |
| Cost at Mainnet RGP (100 MIST) | ~0.71809 SUI |
| Sequential execution time | 53.23 s |
| Effective client throughput | 1,879 recipients/s |

The Mainnet figure normalizes the observed computation units using the live Mainnet reference gas price; it is not a Mainnet execution. Testnet and Mainnet were both on protocol version 134. The source address-balance delta equaled executed gas plus the 100,000 MIST principal, and four sampled recipients changed from 0 to 1 MIST. Execution time is client-observed RPC latency from Tokyo, not validator throughput. See the [result artifact](./sdk/docs/testnet-100k-v1.json), [first transaction](https://testnet.suivision.xyz/txblock/F92ZGKXenvW4eXjZZiviMKPgasGRz3DemHcUu5W9Vgq6), and [last transaction](https://testnet.suivision.xyz/txblock/7soKa6QziZNhMNnHnBoMz11HuLjudQ922sMjw4SM1YJa).

## Reference

- [SDK usage](./sdk/README.md)
- [Codec v1](./sdk/docs/codec-v1.md)
- [Plan and hash format v1](./sdk/docs/plan-v1.md)
- [Golden vectors](./sdk/golden/v1.json)
- [Planner performance](./sdk/docs/performance.md)
- [Testnet benchmark result](./sdk/docs/testnet-100k-v1.json)

## Development

```sh
(cd move && sui move test)
(cd sdk && bun install && bun run golden:check && bun run typecheck && bun run test && bun run build)
```

Run the Testnet benchmark in simulation mode with `bun run benchmark:testnet` from `sdk/`. Add `--execute` only when the configured source is intentionally funded and its key is available in the Sui keystore.

## License

MIT
