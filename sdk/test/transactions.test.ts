import { describe, expect, it } from "vitest";
import {
  createDistributionPlan,
  createMinatoCall,
  createMinatoTx,
} from "../src/index.js";
import { Transaction } from "@mysten/sui/transactions";
import type { DistributionBatch } from "../src/index.js";

const packageId = "0x42";
const plan = createDistributionPlan({
  packageId,
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

describe("transaction builders", () => {
  it("builds one withdrawal Move call, one withdrawal input, and eight padded pairs", () => {
    const transaction = createMinatoTx(packageId).disperseWithdrawal({
      batch: plan.batches[0]!,
    });
    const data = transaction.getData();
    expect(data.sender).toBe(plan.source);
    expect(data.commands).toHaveLength(1);
    expect(data.commands[0]?.MoveCall?.package).toBe(plan.packageId);
    expect(data.commands[0]?.MoveCall?.module).toBe("minato");
    expect(data.commands[0]?.MoveCall?.function).toBe("disperse_withdrawal");
    expect(data.commands[0]?.MoveCall?.arguments).toHaveLength(17);
    expect(data.inputs).toHaveLength(17);
    expect(data.inputs[0]?.$kind).toBe("FundsWithdrawal");
    expect(data.gasData.payment).toBeNull();
    expect(data.gasData.budget).toBeNull();
    expect(data.gasData.price).toBeNull();
  });

  it("provides composable low-level thunks", () => {
    const tx = new Transaction();
    const balance = tx.moveCall({
      target: "0x2::balance::zero",
      typeArguments: [plan.coinType],
    });
    tx.add(
      createMinatoCall(packageId).disperse({
        coinType: plan.coinType,
        balance,
        chunk: plan.batches[0]!.chunks[0]!,
      }),
    );
    expect(tx.getData().commands).toHaveLength(2);
    expect(tx.getData().commands[1]?.MoveCall?.function).toBe("disperse");
  });

  it("rejects package mismatch", () => {
    expect(() =>
      createMinatoTx("0x43").disperseWithdrawal({ batch: plan.batches[0]! }),
    ).toThrow(/package ID/);
  });

  it.each([
    ["source", (batch: DistributionBatch) => ({ ...batch, source: "0x98" })],
    [
      "coin type",
      (batch: DistributionBatch) => ({
        ...batch,
        coinType: "0x2::coin::Coin<0x2::sui::SUI>",
      }),
    ],
    [
      "distribution context",
      (batch: DistributionBatch) => ({
        ...batch,
        distributionHash: `0x${"00".repeat(32)}`,
      }),
    ],
    ["index", (batch: DistributionBatch) => ({ ...batch, index: 1 })],
    [
      "start index",
      (batch: DistributionBatch) => ({ ...batch, startIndex: 1 }),
    ],
    [
      "recipient count",
      (batch: DistributionBatch) => ({ ...batch, recipientCount: 3 }),
    ],
    ["total", (batch: DistributionBatch) => ({ ...batch, totalAmount: "4" })],
    [
      "chunks",
      (batch: DistributionBatch) => ({
        ...batch,
        chunks: [
          {
            ...batch.chunks[0]!,
            totalAmount: "4",
          },
        ],
      }),
    ],
    [
      "batch hash",
      (batch: DistributionBatch) => ({
        ...batch,
        batchHash: `0x${"00".repeat(32)}`,
      }),
    ],
  ])("rejects tampered %s", (_name, mutate) => {
    expect(() =>
      createMinatoTx(packageId).disperseWithdrawal({
        batch: mutate(plan.batches[0]!),
      }),
    ).toThrow();
  });

  it("rejects a tampered package even when the client follows it", () => {
    const batch = { ...plan.batches[0]!, packageId: "0x43" };
    expect(() =>
      createMinatoTx(batch.packageId).disperseWithdrawal({ batch }),
    ).toThrow(/Batch hash/);
  });
});
