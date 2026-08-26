import { describe, expect, it } from "vitest";
import {
  TransactionDataBuilder,
  type TransactionData,
} from "@mysten/sui/transactions";
import {
  MinatoError,
  createDistributionPlan,
  createMinatoTx,
  verifyDistributionPlan,
  type DistributionPlan,
  type OfflineTransactionLimits,
} from "../src/index.js";

const packageId = "0x42";
const source = "0x99";
const coinType = "0x2::sui::SUI";
const exactLimits: OfflineTransactionLimits = {
  maxSignedTransactionBytes: 4096,
  maxPureArgumentBytes: 100,
  gasPaymentCount: 1,
  signatureLengths: [97],
};

function payouts(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    recipient: `0x${(index + 1).toString(16)}`,
    amount: BigInt(Math.floor(index / 3) + 1),
  }));
}

describe("distribution planner", () => {
  it("creates a deterministic, frozen, JSON-safe plan and verifies it", () => {
    const plan = createDistributionPlan({
      packageId,
      source,
      coinType,
      payouts: payouts(20),
      limits: exactLimits,
    });
    expect(plan.recipientCount).toBe(20);
    expect(plan.batches.length).toBeGreaterThan(0);
    expect(
      plan.batches.every(
        (batch) => batch.chunks.length >= 1 && batch.chunks.length <= 8,
      ),
    ).toBe(true);
    expect(
      plan.batches
        .flatMap((batch) => batch.chunks)
        .every((chunk) => chunk.runs.startsWith("0x")),
    ).toBe(true);
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.batches[0]?.chunks)).toBe(true);
    expect(() => JSON.stringify(plan)).not.toThrow();
    expect(verifyDistributionPlan(plan)).toBe(true);
    expect(
      createDistributionPlan({
        packageId,
        source,
        coinType,
        payouts: payouts(20),
        limits: exactLimits,
      }),
    ).toEqual(plan);
  });

  it("keeps the distribution hash independent of batching limits", () => {
    const wide = createDistributionPlan({
      packageId,
      source,
      coinType,
      payouts: payouts(20),
      limits: { ...exactLimits, maxPureArgumentBytes: 1000 },
    });
    const narrow = createDistributionPlan({
      packageId,
      source,
      coinType,
      payouts: payouts(20),
      limits: exactLimits,
    });
    expect(wide.distributionHash).toBe(narrow.distributionHash);
    expect(wide.planHash).not.toBe(narrow.planHash);
  });

  it("supports an explicitly supplied conservative envelope overhead", () => {
    const plan = createDistributionPlan({
      packageId,
      source,
      coinType,
      payouts: payouts(2),
      limits: {
        maxSignedTransactionBytes: 4096,
        maxPureArgumentBytes: 1024,
        gasPaymentCount: 0,
        signatureOverheadBytes: 512,
      },
    });
    expect(plan.limits.signatureModel).toEqual({
      kind: "fixed-overhead",
      bytes: 512,
    });
    expect(plan.batches[0]?.signedTransactionBytes).toBe(
      (plan.batches[0]?.transactionDataBytes ?? 0) + 512,
    );
  });

  it.each([0, 1, 5])(
    "matches official TransactionData BCS sizing with %i gas payments",
    (gasPaymentCount) => {
      const plan = createDistributionPlan({
        packageId,
        source,
        coinType,
        payouts: payouts(75),
        limits: {
          ...exactLimits,
          gasPaymentCount,
        },
      });
      for (const batch of plan.batches) {
        const transaction = createMinatoTx(plan.packageId).disperseWithdrawal({
          batch,
        });
        transaction.setGasPrice(1);
        transaction.setGasBudget(1);
        transaction.setGasPayment(
          Array.from({ length: gasPaymentCount }, (_, index) => ({
            objectId: `0x${(index + 1).toString(16)}`,
            version: "1",
            digest: "11111111111111111111111111111111",
          })),
        );
        if (gasPaymentCount === 0) {
          transaction.setExpiration({
            ValidDuring: {
              minEpoch: "0",
              maxEpoch: "1",
              minTimestamp: null,
              maxTimestamp: null,
              chain: "11111111111111111111111111111111",
              nonce: 0,
            },
          });
        }
        const bytes = new TransactionDataBuilder(
          transaction.getData() as TransactionData,
        ).build();
        expect(batch.transactionDataBytes).toBe(bytes.length);
        expect(batch.signedTransactionBytes).toBe(bytes.length + 103);
      }
    },
  );

  it("rejects tampered plans", () => {
    const plan = createDistributionPlan({
      packageId,
      source,
      coinType,
      payouts: payouts(3),
      limits: exactLimits,
    });
    const tampered = JSON.parse(JSON.stringify(plan)) as DistributionPlan & {
      totalAmount: string;
    };
    tampered.totalAmount = "999";
    expect(() => verifyDistributionPlan(tampered)).toThrow(
      /canonical reconstruction/,
    );
    expect(() => verifyDistributionPlan(null)).toThrow(MinatoError);
    expect(() => verifyDistributionPlan({ version: 1 })).toThrow(MinatoError);
  });

  it("rejects unsafe limits and totals", () => {
    expect(() =>
      createDistributionPlan({
        packageId,
        source,
        coinType,
        payouts: payouts(1),
        limits: { ...exactLimits, signatureOverheadBytes: 100 },
      }),
    ).toThrow(/exactly one/);
    expect(() =>
      createDistributionPlan({
        packageId,
        source,
        coinType,
        payouts: [
          { recipient: "0x1", amount: (1n << 64n) - 1n },
          { recipient: "0x2", amount: 1n },
        ],
        limits: exactLimits,
      }),
    ).toThrow(MinatoError);
    expect(() =>
      createDistributionPlan({
        packageId,
        source,
        coinType: "0x2::coin::Coin<@named/package::token::TOKEN>",
        payouts: payouts(1),
        limits: exactLimits,
      }),
    ).toThrow(/concrete struct tag/);
    expect(() =>
      createDistributionPlan({
        packageId,
        source,
        coinType,
        payouts: payouts(1),
        limits: {
          ...exactLimits,
          signatureLengths: [0x1_0000_0000],
        },
      }),
    ).toThrow(/supported integer range|4294967295/);
  });
});
