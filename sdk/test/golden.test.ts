import { bcs } from "@mysten/sui/bcs";
import {
  TransactionDataBuilder,
  type TransactionData,
} from "@mysten/sui/transactions";
import { sha256 } from "@noble/hashes/sha2.js";
import { describe, expect, it } from "vitest";
import {
  createDistributionPlan,
  createMinatoTx,
  decodeRuns,
  encodeRuns,
} from "../src/index.js";
import golden from "../golden/v1.json" with { type: "json" };

const ZERO_DIGEST = "11111111111111111111111111111111";

function fromHex(value: string): Uint8Array {
  return Uint8Array.from(
    value
      .slice(2)
      .match(/.{2}/g)
      ?.map((byte) => Number.parseInt(byte, 16)) ?? [],
  );
}

function toHex(bytes: Uint8Array): string {
  return `0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function concat(...parts: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(
    parts.reduce((length, part) => length + part.length, 0),
  );
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function domainHash(domain: string, payloadHex: string): string {
  return toHex(
    sha256(
      concat(new TextEncoder().encode(`${domain}\0`), fromHex(payloadHex)),
    ),
  );
}

describe("independently derived golden vectors v1", () => {
  it("pins the derivation provenance", () => {
    expect(golden.format).toBe("minato-golden-v1");
    expect(golden.provenance).toEqual({
      minatoImports: false,
      manualBcsCrossCheckedWith: "@mysten/sui@2.17.0",
      hashImplementation: "node:crypto SHA-256",
      transactionConstruction: "direct @mysten/sui Transaction API",
    });
  });

  it.each(golden.codec)("matches codec vector $name", (vector) => {
    const payouts = vector.payouts.map((payout) => ({
      recipient: payout.recipient,
      amount: BigInt(payout.amount),
    }));
    const encoded = encodeRuns(payouts);
    expect(toHex(encoded)).toBe(vector.runsHex);
    expect(
      decodeRuns(
        payouts.map((payout) => payout.recipient),
        encoded,
      ),
    ).toEqual(payouts);
  });

  it.each(golden.codecPatterns)(
    "matches generated codec boundary $name",
    (vector) => {
      const payouts = Array.from(
        { length: vector.recipientCount },
        (_, index) => ({
          recipient: `0x${(index + 1).toString(16).padStart(64, "0")}`,
          amount:
            vector.amountPattern.kind === "constant"
              ? BigInt(vector.amountPattern.value!)
              : BigInt(vector.amountPattern.start!) + BigInt(index),
        }),
      );
      expect(toHex(encodeRuns(payouts))).toBe(vector.runsHex);
    },
  );

  it("pins every domain-separated hash payload", () => {
    expect(
      domainHash(
        "minato/distribution/v1",
        golden.plan.payloads.distributionHex,
      ),
    ).toBe(golden.plan.hashes.distributionHash);
    expect(domainHash("minato/batch/v1", golden.plan.payloads.batchHex)).toBe(
      golden.plan.hashes.batchHash,
    );
    expect(domainHash("minato/plan/v1", golden.plan.payloads.planHex)).toBe(
      golden.plan.hashes.planHash,
    );
    expect(
      domainHash("minato/plan/v1", golden.plan.fixedOverhead.planPayloadHex),
    ).toBe(golden.plan.fixedOverhead.planHash);
  });

  it("pins the plan, PTB, and signed transaction envelope", () => {
    const input = golden.plan.input;
    const plan = createDistributionPlan({
      packageId: input.packageId,
      source: input.source,
      coinType: input.coinType,
      payouts: input.payouts.map((payout) => ({
        recipient: payout.recipient,
        amount: BigInt(payout.amount),
      })),
      limits: input.limits,
    });

    expect(plan.packageId).toBe(golden.plan.canonical.packageId);
    expect(plan.source).toBe(golden.plan.canonical.source);
    expect(plan.coinType).toBe(golden.plan.canonical.coinType);
    expect(plan.distributionHash).toBe(golden.plan.hashes.distributionHash);
    expect(plan.batches[0]?.batchHash).toBe(golden.plan.hashes.batchHash);
    expect(plan.planHash).toBe(golden.plan.hashes.planHash);
    expect(plan.batches[0]?.chunks).toEqual(
      golden.plan.canonical.chunks.map((chunk) => ({
        recipients: chunk.recipients,
        runs: chunk.runsHex,
        recipientCount: chunk.recipientCount,
        totalAmount: chunk.totalAmount,
      })),
    );

    const transaction = createMinatoTx(plan.packageId).disperseWithdrawal({
      batch: plan.batches[0]!,
    });
    transaction.setGasPrice(1);
    transaction.setGasBudget(1);
    transaction.setGasPayment([
      { objectId: "0x1", version: "1", digest: ZERO_DIGEST },
    ]);
    const data = transaction.getData();
    const transactionData = new TransactionDataBuilder(
      data as TransactionData,
    ).build();
    expect(toHex(transactionData)).toBe(
      golden.plan.transaction.transactionDataHex,
    );
    expect(transactionData).toHaveLength(
      golden.plan.transaction.transactionDataBytes,
    );
    expect(toHex(sha256(transactionData))).toBe(
      golden.plan.transaction.transactionDataSha256,
    );
    expect(data.inputs).toHaveLength(golden.plan.transaction.inputCount);
    expect(data.commands).toHaveLength(golden.plan.transaction.commandCount);
    expect(data.commands[0]?.MoveCall?.arguments).toHaveLength(
      golden.plan.transaction.moveCallArgumentCount,
    );

    const signedEnvelope = bcs.SenderSignedData.serialize([
      {
        intentMessage: {
          intent: {
            scope: { TransactionData: true },
            version: { V0: true },
            appId: { Sui: true },
          },
          value: bcs.TransactionData.parse(transactionData),
        },
        txSignatures: [Uint8Array.from({ length: 97 }, (_, index) => index)],
      },
    ]).toBytes();
    expect(toHex(signedEnvelope)).toBe(
      golden.plan.transaction.signedEnvelopeHex,
    );
    expect(signedEnvelope).toHaveLength(
      golden.plan.transaction.signedEnvelopeBytes,
    );
    expect(toHex(sha256(signedEnvelope))).toBe(
      golden.plan.transaction.signedEnvelopeSha256,
    );
  });

  it("pins the fixed-overhead signature model", () => {
    const input = golden.plan.input;
    const plan = createDistributionPlan({
      packageId: input.packageId,
      source: input.source,
      coinType: input.coinType,
      payouts: input.payouts.map((payout) => ({
        recipient: payout.recipient,
        amount: BigInt(payout.amount),
      })),
      limits: golden.plan.fixedOverhead.limits,
    });
    expect(plan.planHash).toBe(golden.plan.fixedOverhead.planHash);
    expect(plan.batches[0]?.signedTransactionBytes).toBe(
      golden.plan.fixedOverhead.signedTransactionBytes,
    );
  });
});
