import { expect, it } from "vitest";
import { createDistributionPlan } from "../src/index.js";

it("matches the plan v1 golden hashes", () => {
  const plan = createDistributionPlan({
    packageId: "0x42",
    source: "0x99",
    coinType: "0x2::sui::SUI",
    payouts: [
      { recipient: "0x1", amount: 1n },
      { recipient: "0x2", amount: 2n },
    ],
    limits: {
      maxSignedTransactionBytes: 4096,
      maxPureArgumentBytes: 1024,
      gasPaymentCount: 1,
      signatureLengths: [97],
    },
  });

  expect(plan.distributionHash).toBe(
    "0xc904195a03a60786c90b0389dd6e9570f6c1fc203c37f3d2cbbdce112a4dc3be",
  );
  expect(plan.batches[0]?.batchHash).toBe(
    "0x79abd8865670405c0deeda9bd88d71b68a9396e5965d4cb7364614e3de6f9c26",
  );
  expect(plan.planHash).toBe(
    "0xe15986580df17dfc8323016da44074e42fcc2afb6bf44a17d18a65e2b1d1f2f9",
  );
  expect(plan.batches[0]?.transactionDataBytes).toBe(485);
  expect(plan.batches[0]?.signedTransactionBytes).toBe(588);
});
