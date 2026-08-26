# `@unconfirmedlabs/minato`

Browser-safe TypeScript tools for Minato distributions on Sui. The package plans and verifies distributions offline and constructs composable transactions. It does not sign, execute, parse CSV, persist progress, or retry requests.

The new fixed-eight Move ABI has not been published, so the SDK intentionally has no default package ID.

## Install

```sh
npm install @unconfirmedlabs/minato @mysten/sui
```

Node.js 22 or newer is required when running the SDK on Node, matching `@mysten/sui` 2.17.

## Plan offline

```ts
import {
  createDistributionPlan,
  verifyDistributionPlan,
} from "@unconfirmedlabs/minato";

const plan = createDistributionPlan({
  packageId: "0x...",
  source: "0x...",
  coinType: "0x2::sui::SUI",
  payouts: [
    { recipient: "0x...", amount: 100n },
    { recipient: "0x...", amount: 250n },
  ],
  limits: {
    maxSignedTransactionBytes: 131_072,
    maxPureArgumentBytes: 16_384,
    gasPaymentCount: 0, // address-balance gas
    // Full serialized generic-signature lengths, including scheme metadata.
    signatureLengths: [97],
  },
});

verifyDistributionPlan(plan);
JSON.stringify(plan); // bigint values are stored as decimal strings in plans
```

Use `signatureLengths` for exact `SenderSignedData` envelope sizing. For a signer format that cannot be represented as fixed serialized signature lengths, provide a conservative `signatureOverheadBytes` instead. Exactly one model is required; the SDK never assumes Ledger, Ed25519, multisig, or another signer.

## Build transactions

```ts
import { minato } from "@unconfirmedlabs/minato";
import { SuiGrpcClient } from "@mysten/sui/grpc";

const client = new SuiGrpcClient({
  network: "mainnet",
  baseUrl: "https://fullnode.mainnet.sui.io:443",
}).$extend(minato({ packageId: "0x..." }));

const transaction = client.minato.tx.disperseWithdrawal({
  batch: plan.batches[0],
});
```

The transaction builder sets the sender, creates one `FundsWithdrawal`, adds exactly one Minato Move call, pads its fixed ABI to eight address/run pairs, and leaves all gas data unset for the wallet or sponsor.

Composable low-level thunks are available under `client.minato.call` and through `createMinatoCall(packageId)`:

```ts
transaction.add(
  client.minato.call.disperse({
    coinType: plan.coinType,
    balance,
    chunk: plan.batches[0].chunks[0],
  }),
);
```

Bindings are handwritten and isolated in `src/transactions.ts`. Code generation needs a published package/ABI; it can replace that file without changing the stable SDK surface after publication.

See [codec-v1.md](./docs/codec-v1.md) and [plan-v1.md](./docs/plan-v1.md) for the wire and hash specifications.
