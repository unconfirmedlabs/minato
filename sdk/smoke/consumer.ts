import { SuiGrpcClient } from "@mysten/sui/grpc";
import {
  createDistributionPlan,
  minato,
  type DistributionPlan,
} from "@unconfirmedlabs/minato";

const plan: DistributionPlan = createDistributionPlan({
  packageId: "0x42",
  source: "0x99",
  coinType: "0x2::sui::SUI",
  payouts: [{ recipient: "0x1", amount: 1n }],
  limits: {
    maxSignedTransactionBytes: 4096,
    maxPureArgumentBytes: 1024,
    gasPaymentCount: 1,
    signatureLengths: [97],
  },
});

const client = new SuiGrpcClient({
  network: "localnet",
  baseUrl: "http://127.0.0.1:9000",
}).$extend(minato({ packageId: plan.packageId, name: "distribution" }));

client.distribution.tx.disperseWithdrawal({ batch: plan.batches[0]! });
