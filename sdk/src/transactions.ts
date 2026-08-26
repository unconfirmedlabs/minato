import { bcs } from "@mysten/sui/bcs";
import {
  Transaction,
  type TransactionObjectArgument,
  type TransactionResult,
} from "@mysten/sui/transactions";
import { MAX_CHUNKS_PER_BATCH, MAX_U64 } from "./constants.js";
import { canonicalizePayouts, decodeRuns } from "./codec.js";
import { MinatoError } from "./errors.js";
import { hashBatch } from "./hashing.js";
import { hexToBytes, normalizeAddress, normalizeCoinType } from "./internal.js";
import type {
  DisperseCallOptions,
  DisperseWithdrawalCallOptions,
  DisperseWithdrawalTransactionOptions,
  DistributionBatch,
  DistributionChunk,
  Payout,
} from "./types.js";

function validateChunk(chunk: DistributionChunk): Payout[] {
  const payouts = decodeRuns(chunk.recipients, hexToBytes(chunk.runs));
  const total = payouts.reduce((sum, payout) => sum + payout.amount, 0n);
  if (
    chunk.recipientCount !== payouts.length ||
    chunk.totalAmount !== total.toString()
  ) {
    throw new MinatoError(
      "INVALID_PLAN",
      "Chunk metadata does not match its encoded payouts",
    );
  }
  return payouts;
}

function canonicalPositiveU64(value: string, label: string): bigint {
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) {
    throw new MinatoError(
      "INVALID_PLAN",
      `${label} must be a canonical positive decimal u64`,
    );
  }
  const amount = BigInt(value);
  if (amount > MAX_U64) {
    throw new MinatoError("INVALID_PLAN", `${label} is outside u64`);
  }
  return amount;
}

function safeIndex(value: number, label: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new MinatoError(
      "INVALID_PLAN",
      `${label} is outside its supported integer range`,
    );
  }
  return value;
}

function validateCanonicalPayoutSequence(payouts: readonly Payout[]): void {
  const canonical = canonicalizePayouts(payouts);
  for (let index = 0; index < payouts.length; index += 1) {
    if (
      payouts[index]?.recipient !== canonical[index]?.recipient ||
      payouts[index]?.amount !== canonical[index]?.amount
    ) {
      throw new MinatoError(
        "INVALID_PLAN",
        "Batch chunks are not one canonical payout sequence",
      );
    }
  }
}

function validateBatch(
  batch: DistributionBatch,
  expectedPackageId: string,
): {
  source: string;
  coinType: string;
  total: bigint;
} {
  const packageId = normalizeAddress(batch.packageId, "batch.packageId");
  if (packageId !== expectedPackageId) {
    throw new MinatoError(
      "PACKAGE_MISMATCH",
      "Batch package ID does not match this Minato client",
    );
  }
  const source = normalizeAddress(batch.source, "batch.source");
  const coinType = normalizeCoinType(batch.coinType);
  hexToBytes(batch.distributionHash, 32);
  const index = safeIndex(batch.index, "batch.index", 0xffff_ffff);
  const startIndex = safeIndex(
    batch.startIndex,
    "batch.startIndex",
    Number.MAX_SAFE_INTEGER,
  );
  const endIndex = safeIndex(
    batch.endIndex,
    "batch.endIndex",
    Number.MAX_SAFE_INTEGER,
  );
  const recipientCount = safeIndex(
    batch.recipientCount,
    "batch.recipientCount",
    Number.MAX_SAFE_INTEGER,
  );
  if (batch.chunks.length === 0 || batch.chunks.length > MAX_CHUNKS_PER_BATCH) {
    throw new MinatoError(
      "INVALID_PLAN",
      "A withdrawal batch requires one to eight chunks",
    );
  }

  const payouts = batch.chunks.flatMap(validateChunk);
  validateCanonicalPayoutSequence(payouts);
  if (
    recipientCount !== payouts.length ||
    endIndex !== startIndex + recipientCount
  ) {
    throw new MinatoError(
      "INVALID_PLAN",
      "Batch range metadata does not match its chunks",
    );
  }

  const total = canonicalPositiveU64(batch.totalAmount, "batch.totalAmount");
  const payoutTotal = payouts.reduce((sum, payout) => sum + payout.amount, 0n);
  if (payoutTotal !== total) {
    throw new MinatoError(
      "INVALID_PLAN",
      "Batch total does not equal its encoded payouts",
    );
  }

  const expectedHash = hashBatch({
    distributionHash: batch.distributionHash,
    packageId,
    source,
    coinType,
    index,
    startIndex,
    withdrawalTotal: total,
    chunks: batch.chunks,
  });
  if (batch.batchHash !== expectedHash) {
    throw new MinatoError(
      "INVALID_PLAN",
      "Batch hash does not match its transaction context and payouts",
    );
  }
  return { source, coinType, total };
}

function recipientArgument(tx: Transaction, recipients: readonly string[]) {
  return tx.pure(bcs.vector(bcs.Address).serialize([...recipients]));
}

function runsArgument(tx: Transaction, runs: string) {
  return tx.pure(bcs.vector(bcs.U8).serialize(hexToBytes(runs)));
}

function addDisperseWithdrawalMoveCall(
  tx: Transaction,
  packageId: string,
  coinType: string,
  withdrawal: TransactionObjectArgument,
  chunks: readonly DistributionChunk[],
): TransactionResult {
  const arguments_: TransactionObjectArgument[] = [withdrawal];
  for (let index = 0; index < MAX_CHUNKS_PER_BATCH; index += 1) {
    const chunk = chunks[index];
    if (chunk) {
      arguments_.push(
        recipientArgument(tx, chunk.recipients),
        runsArgument(tx, chunk.runs),
      );
    } else {
      arguments_.push(recipientArgument(tx, []), runsArgument(tx, "0x"));
    }
  }
  return tx.moveCall({
    target: `${packageId}::minato::disperse_withdrawal`,
    typeArguments: [coinType],
    arguments: arguments_,
  });
}

/** @internal Builds from values already validated by the planner or public builder. */
export function createValidatedWithdrawalTransaction(options: {
  packageId: string;
  source: string;
  coinType: string;
  total: bigint;
  chunks: readonly DistributionChunk[];
}): Transaction {
  const transaction = new Transaction();
  transaction.setSender(options.source);
  const withdrawal = transaction.withdrawal({
    amount: options.total,
    type: options.coinType,
  });
  addDisperseWithdrawalMoveCall(
    transaction,
    options.packageId,
    options.coinType,
    withdrawal,
    options.chunks,
  );
  return transaction;
}

export function createMinatoCall(packageIdInput: string) {
  const packageId = normalizeAddress(packageIdInput, "packageId");
  return {
    disperse(options: DisperseCallOptions) {
      const coinType = normalizeCoinType(options.coinType);
      validateChunk(options.chunk);
      return (tx: Transaction): TransactionResult =>
        tx.moveCall({
          target: `${packageId}::minato::disperse`,
          typeArguments: [coinType],
          arguments: [
            options.balance,
            recipientArgument(tx, options.chunk.recipients),
            runsArgument(tx, options.chunk.runs),
          ],
        });
    },

    disperseWithdrawal(options: DisperseWithdrawalCallOptions) {
      const coinType = normalizeCoinType(options.coinType);
      if (
        options.chunks.length === 0 ||
        options.chunks.length > MAX_CHUNKS_PER_BATCH
      ) {
        throw new MinatoError(
          "INVALID_PLAN",
          "A withdrawal call requires one to eight chunks",
        );
      }
      options.chunks.forEach(validateChunk);
      return (tx: Transaction): TransactionResult =>
        addDisperseWithdrawalMoveCall(
          tx,
          packageId,
          coinType,
          options.withdrawal,
          options.chunks,
        );
    },
  } as const;
}

export function createMinatoTx(packageIdInput: string) {
  const packageId = normalizeAddress(packageIdInput, "packageId");
  return {
    disperseWithdrawal(
      options: DisperseWithdrawalTransactionOptions,
    ): Transaction {
      const { batch } = options;
      const { source, coinType, total } = validateBatch(batch, packageId);

      return createValidatedWithdrawalTransaction({
        packageId,
        source,
        coinType,
        total,
        chunks: batch.chunks,
      });
    },
  } as const;
}
