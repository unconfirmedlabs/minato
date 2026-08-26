import {
  TransactionDataBuilder,
  type TransactionData,
} from "@mysten/sui/transactions";
import { MAX_CHUNKS_PER_BATCH, MAX_U64, PLAN_VERSION } from "./constants.js";
import {
  canonicalizePayouts,
  decodeRuns,
  encodeCanonicalRuns,
} from "./codec.js";
import { MinatoError } from "./errors.js";
import { hashBatch, hashDistribution, hashPlan } from "./hashing.js";
import {
  bytesToHex,
  deepFreeze,
  hexToBytes,
  normalizeAddress,
  normalizeCoinType,
  ulebLength,
} from "./internal.js";
import { createValidatedWithdrawalTransaction } from "./transactions.js";
import type {
  CreateDistributionPlanOptions,
  DistributionBatch,
  DistributionChunk,
  DistributionPlan,
  LimitSnapshot,
  OfflineTransactionLimits,
  Payout,
} from "./types.js";

const ZERO_DIGEST = "11111111111111111111111111111111";

function safeInteger(
  value: number,
  label: string,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new MinatoError(
      "INVALID_LIMITS",
      `${label} must be a safe integer in ${minimum}..${maximum}`,
    );
  }
  return value;
}

function normalizeLimits(limits: OfflineTransactionLimits): LimitSnapshot {
  const maxSignedTransactionBytes = safeInteger(
    limits.maxSignedTransactionBytes,
    "maxSignedTransactionBytes",
    1,
  );
  const maxPureArgumentBytes = safeInteger(
    limits.maxPureArgumentBytes,
    "maxPureArgumentBytes",
    1,
  );
  const gasPaymentCount = safeInteger(
    limits.gasPaymentCount,
    "gasPaymentCount",
    0,
    0xffff_ffff,
  );
  if (gasPaymentCount > maxSignedTransactionBytes) {
    throw new MinatoError(
      "INVALID_LIMITS",
      "gasPaymentCount cannot fit within maxSignedTransactionBytes",
    );
  }
  const hasLengths = limits.signatureLengths !== undefined;
  const hasOverhead = limits.signatureOverheadBytes !== undefined;
  if (hasLengths === hasOverhead) {
    throw new MinatoError(
      "INVALID_LIMITS",
      "Specify exactly one of signatureLengths or signatureOverheadBytes",
    );
  }
  if (limits.signatureLengths) {
    if (limits.signatureLengths.length === 0) {
      throw new MinatoError(
        "INVALID_LIMITS",
        "signatureLengths must contain at least one signature",
      );
    }
    const lengths = limits.signatureLengths.map((length, index) =>
      safeInteger(length, `signatureLengths[${index}]`, 1, 0xffff_ffff),
    );
    return {
      maxSignedTransactionBytes,
      maxPureArgumentBytes,
      gasPaymentCount,
      signatureModel: { kind: "serialized-signatures", lengths },
    };
  }
  return {
    maxSignedTransactionBytes,
    maxPureArgumentBytes,
    gasPaymentCount,
    signatureModel: {
      kind: "fixed-overhead",
      bytes: safeInteger(
        limits.signatureOverheadBytes!,
        "signatureOverheadBytes",
        0,
      ),
    },
  };
}

function limitsToInput(limits: LimitSnapshot): OfflineTransactionLimits {
  return limits.signatureModel.kind === "serialized-signatures"
    ? {
        maxSignedTransactionBytes: limits.maxSignedTransactionBytes,
        maxPureArgumentBytes: limits.maxPureArgumentBytes,
        gasPaymentCount: limits.gasPaymentCount,
        signatureLengths: limits.signatureModel.lengths,
      }
    : {
        maxSignedTransactionBytes: limits.maxSignedTransactionBytes,
        maxPureArgumentBytes: limits.maxPureArgumentBytes,
        gasPaymentCount: limits.gasPaymentCount,
        signatureOverheadBytes: limits.signatureModel.bytes,
      };
}

function signedSize(
  transactionDataBytes: number,
  limits: LimitSnapshot,
): number {
  if (limits.signatureModel.kind === "fixed-overhead") {
    return transactionDataBytes + limits.signatureModel.bytes;
  }
  const lengths = limits.signatureModel.lengths;
  // SenderSignedData = vector[IntentMessage<TransactionData>, vector<vector<u8>>].
  // The three one-byte intent enum tags and all ULEB vector lengths are included.
  return (
    transactionDataBytes +
    ulebLength(1) +
    3 +
    ulebLength(lengths.length) +
    lengths.reduce((sum, length) => sum + ulebLength(length) + length, 0)
  );
}

function ulebBigintLength(value: bigint): number {
  let remaining = value;
  let length = 1;
  while (remaining >= 0x80n) {
    remaining >>= 7n;
    length += 1;
  }
  return length;
}

function addressVectorBytes(recipientCount: number): number {
  return ulebLength(recipientCount) + recipientCount * 32;
}

function pureCallArgumentBytes(serializedValueBytes: number): number {
  return ulebLength(serializedValueBytes) + serializedValueBytes;
}

interface AmountGroup {
  readonly amount: bigint;
  readonly start: number;
  end: number;
}

interface PayoutAnalysis {
  readonly payouts: readonly Payout[];
  readonly groups: readonly AmountGroup[];
  readonly groupAtPayout: Uint32Array;
  /** Prefix sum of each group's global delta plus its full run count. */
  readonly followingGroupBytesPrefix: readonly number[];
  readonly maxRecipientsPerChunk: number;
}

interface ChunkShape {
  readonly start: number;
  readonly end: number;
  readonly recipientVectorBytes: number;
  readonly runsVectorBytes: number;
}

function maximumAddressRecipients(maxPureArgumentBytes: number): number {
  let low = 0;
  let high = Math.floor(maxPureArgumentBytes / 32);
  let best = 0;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (addressVectorBytes(middle) <= maxPureArgumentBytes) {
      best = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return best;
}

function analyzePayouts(
  payouts: readonly Payout[],
  maxPureArgumentBytes: number,
): PayoutAnalysis {
  const groups: AmountGroup[] = [];
  const groupAtPayout = new Uint32Array(payouts.length);
  for (const [index, payout] of payouts.entries()) {
    let group = groups.at(-1);
    if (!group || group.amount !== payout.amount) {
      group = { amount: payout.amount, start: index, end: index + 1 };
      groups.push(group);
    } else {
      group.end = index + 1;
    }
    groupAtPayout[index] = groups.length - 1;
  }

  const followingGroupBytesPrefix = [0];
  for (let index = 0; index < groups.length; index += 1) {
    const group = groups[index]!;
    const previous = groups[index - 1];
    const bytes = previous
      ? ulebBigintLength(group.amount - previous.amount) +
        ulebLength(group.end - group.start)
      : 0;
    followingGroupBytesPrefix.push(followingGroupBytesPrefix[index]! + bytes);
  }

  return {
    payouts,
    groups,
    groupAtPayout,
    followingGroupBytesPrefix,
    maxRecipientsPerChunk: maximumAddressRecipients(maxPureArgumentBytes),
  };
}

function runsBytes(
  analysis: PayoutAnalysis,
  start: number,
  end: number,
): number {
  const firstGroupIndex = analysis.groupAtPayout[start];
  const lastGroupIndex = analysis.groupAtPayout[end - 1];
  if (firstGroupIndex === undefined || lastGroupIndex === undefined) {
    throw new MinatoError("INVALID_PLAN", "Cannot encode an empty chunk");
  }
  const firstGroup = analysis.groups[firstGroupIndex]!;
  const groupCount = lastGroupIndex - firstGroupIndex + 1;
  let bytes =
    ulebLength(groupCount) +
    ulebBigintLength(firstGroup.amount) +
    ulebLength(Math.min(end, firstGroup.end) - start);

  if (lastGroupIndex !== firstGroupIndex) {
    bytes +=
      analysis.followingGroupBytesPrefix[lastGroupIndex]! -
      analysis.followingGroupBytesPrefix[firstGroupIndex + 1]!;
    const lastGroup = analysis.groups[lastGroupIndex]!;
    const previousGroup = analysis.groups[lastGroupIndex - 1]!;
    bytes +=
      ulebBigintLength(lastGroup.amount - previousGroup.amount) +
      ulebLength(end - lastGroup.start);
  }
  return bytes;
}

function chunkShape(
  analysis: PayoutAnalysis,
  start: number,
  end: number,
): ChunkShape {
  const encodedRunsBytes = runsBytes(analysis, start, end);
  return {
    start,
    end,
    recipientVectorBytes: addressVectorBytes(end - start),
    runsVectorBytes: ulebLength(encodedRunsBytes) + encodedRunsBytes,
  };
}

function makeChunk(
  payouts: readonly Payout[],
  start: number,
  end: number,
): DistributionChunk {
  const chunkPayouts = payouts.slice(start, end);
  const runs = encodeCanonicalRuns(chunkPayouts);
  const total = chunkPayouts.reduce((sum, payout) => sum + payout.amount, 0n);
  return {
    recipients: chunkPayouts.map((payout) => payout.recipient),
    runs: bytesToHex(runs),
    recipientCount: chunkPayouts.length,
    totalAmount: total.toString(),
  };
}

function largestChunkEnd(
  analysis: PayoutAnalysis,
  start: number,
  end: number,
  maxPureArgumentBytes: number,
): number {
  const high = Math.min(end, start + analysis.maxRecipientsPerChunk);
  if (high === start) return start;
  if (
    chunkShape(analysis, start, high).runsVectorBytes <= maxPureArgumentBytes
  ) {
    return high;
  }

  let low = start + 1;
  let searchHigh = high;
  let best = start;
  while (low <= searchHigh) {
    const middle = Math.floor((low + searchHigh) / 2);
    if (
      chunkShape(analysis, start, middle).runsVectorBytes <=
      maxPureArgumentBytes
    ) {
      best = middle;
      low = middle + 1;
    } else {
      searchHigh = middle - 1;
    }
  }
  return best;
}

function chunkRange(
  analysis: PayoutAnalysis,
  start: number,
  end: number,
  maxPureArgumentBytes: number,
): ChunkShape[] | null {
  const chunks: ChunkShape[] = [];
  let cursor = start;
  while (cursor < end) {
    if (chunks.length === MAX_CHUNKS_PER_BATCH) return null;
    const chunkEnd = largestChunkEnd(
      analysis,
      cursor,
      end,
      maxPureArgumentBytes,
    );
    if (chunkEnd === cursor) return null;
    chunks.push(chunkShape(analysis, cursor, chunkEnd));
    cursor = chunkEnd;
  }
  return chunks;
}

interface TransactionSizeModel {
  readonly size: (chunks: readonly ChunkShape[]) => number;
}

function createTransactionSizeModel(
  packageId: string,
  source: string,
  coinType: string,
  limits: LimitSnapshot,
): TransactionSizeModel {
  // The withdrawal amount is a fixed-width u64. Build the exact transaction
  // once with all eight argument pairs padded empty, then replace the byte
  // vector contribution of each populated pure input arithmetically.
  const transaction = createValidatedWithdrawalTransaction({
    packageId,
    source,
    coinType,
    total: 1n,
    chunks: [],
  });
  transaction.setGasPrice(1);
  transaction.setGasBudget(1);
  transaction.setGasPayment(
    Array.from({ length: limits.gasPaymentCount }, (_, index) => ({
      objectId: `0x${(index + 1).toString(16)}`,
      version: "1",
      digest: ZERO_DIGEST,
    })),
  );
  const builder = new TransactionDataBuilder(
    transaction.getData() as TransactionData,
  );
  const emptyPureCallArgumentBytes = pureCallArgumentBytes(1);
  const emptyTransactionDataBytes = builder.build().length;
  return {
    size(chunks) {
      return chunks.reduce(
        (total, chunk) =>
          total +
          pureCallArgumentBytes(chunk.recipientVectorBytes) -
          emptyPureCallArgumentBytes +
          pureCallArgumentBytes(chunk.runsVectorBytes) -
          emptyPureCallArgumentBytes,
        emptyTransactionDataBytes,
      );
    },
  };
}

interface Candidate {
  readonly chunks: readonly ChunkShape[];
  readonly transactionDataBytes: number;
  readonly signedTransactionBytes: number;
}

function candidateForRange(
  analysis: PayoutAnalysis,
  transactionSizes: TransactionSizeModel,
  start: number,
  end: number,
  limits: LimitSnapshot,
): Candidate | null {
  const chunks = chunkRange(analysis, start, end, limits.maxPureArgumentBytes);
  if (!chunks) return null;
  const transactionDataBytes = transactionSizes.size(chunks);
  const signedTransactionBytes = signedSize(transactionDataBytes, limits);
  if (signedTransactionBytes > limits.maxSignedTransactionBytes) return null;
  return { chunks, transactionDataBytes, signedTransactionBytes };
}

export function createDistributionPlan(
  options: CreateDistributionPlanOptions,
): DistributionPlan {
  const packageId = normalizeAddress(options.packageId, "packageId");
  const source = normalizeAddress(options.source, "source");
  const coinType = normalizeCoinType(options.coinType);
  const payouts = canonicalizePayouts(options.payouts);
  const limits = normalizeLimits(options.limits);
  const totalAmount = payouts.reduce((sum, payout) => sum + payout.amount, 0n);
  if (totalAmount > MAX_U64) {
    throw new MinatoError(
      "INVALID_PAYOUT",
      "The distribution total exceeds u64::MAX",
    );
  }
  const distributionHash = hashDistribution({
    packageId,
    source,
    coinType,
    payouts,
  });
  const analysis = analyzePayouts(payouts, limits.maxPureArgumentBytes);
  const transactionSizes = createTransactionSizeModel(
    packageId,
    source,
    coinType,
    limits,
  );

  const batches: DistributionBatch[] = [];
  let start = 0;
  while (start < payouts.length) {
    let low = start + 1;
    let high = Math.min(
      payouts.length,
      start + MAX_CHUNKS_PER_BATCH * analysis.maxRecipientsPerChunk,
    );
    let bestEnd = start;
    let bestCandidate: Candidate | null = null;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const candidate = candidateForRange(
        analysis,
        transactionSizes,
        start,
        middle,
        limits,
      );
      if (candidate) {
        bestEnd = middle;
        bestCandidate = candidate;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    if (!bestCandidate || bestEnd === start) {
      throw new MinatoError(
        "TRANSACTION_TOO_LARGE",
        `No valid transaction can contain payout ${start} under the supplied limits`,
      );
    }

    const chunks = bestCandidate.chunks.map((chunk) =>
      makeChunk(payouts, chunk.start, chunk.end),
    );
    const batchTotal = chunks.reduce(
      (sum, chunk) => sum + BigInt(chunk.totalAmount),
      0n,
    );
    const batchHash = hashBatch({
      distributionHash,
      packageId,
      source,
      coinType,
      index: batches.length,
      startIndex: start,
      withdrawalTotal: batchTotal,
      chunks,
    });
    batches.push({
      index: batches.length,
      startIndex: start,
      endIndex: bestEnd,
      packageId,
      source,
      coinType,
      distributionHash,
      recipientCount: bestEnd - start,
      totalAmount: batchTotal.toString(),
      transactionDataBytes: bestCandidate.transactionDataBytes,
      signedTransactionBytes: bestCandidate.signedTransactionBytes,
      batchHash,
      chunks,
    });
    start = bestEnd;
  }

  const plan: DistributionPlan = {
    version: PLAN_VERSION,
    packageId,
    source,
    coinType,
    recipientCount: payouts.length,
    totalAmount: totalAmount.toString(),
    distributionHash,
    planHash: hashPlan(
      distributionHash,
      limits,
      batches.map((batch) => batch.batchHash),
    ),
    limits,
    batches,
  };
  return deepFreeze(plan);
}

function invalidPlan(message: string): never {
  throw new MinatoError(
    "INVALID_PLAN",
    `Plan does not match its canonical reconstruction: ${message}`,
  );
}

function assertExactKeys(
  value: object,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  if (
    actual.length !== canonical.length ||
    actual.some((key, index) => key !== canonical[index])
  ) {
    invalidPlan(`${label} has missing or unexpected fields`);
  }
}

function planInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    invalidPlan(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function planAmount(value: string, label: string): bigint {
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) {
    invalidPlan(`${label} must be a canonical positive decimal u64`);
  }
  const amount = BigInt(value);
  if (amount > MAX_U64) invalidPlan(`${label} is outside u64`);
  return amount;
}

function sameShapes(
  expected: readonly ChunkShape[],
  actualRanges: readonly (readonly [number, number])[],
): boolean {
  return (
    expected.length === actualRanges.length &&
    expected.every(
      (shape, index) =>
        shape.start === actualRanges[index]?.[0] &&
        shape.end === actualRanges[index]?.[1],
    )
  );
}

interface DecodedBatch {
  readonly batch: DistributionBatch;
  readonly chunkRanges: readonly (readonly [number, number])[];
  readonly total: bigint;
}

/** Verify every codec, hash, canonical boundary, limit, and size commitment. */
export function verifyDistributionPlan(
  value: unknown,
): value is DistributionPlan {
  try {
    if (!value || typeof value !== "object") {
      throw new MinatoError("INVALID_PLAN", "Plan must be an object");
    }
    const plan = value as DistributionPlan;
    assertExactKeys(
      plan,
      [
        "version",
        "packageId",
        "source",
        "coinType",
        "recipientCount",
        "totalAmount",
        "distributionHash",
        "planHash",
        "limits",
        "batches",
      ],
      "plan",
    );
    if (plan.version !== PLAN_VERSION) {
      throw new MinatoError(
        "INVALID_PLAN",
        `Unsupported plan version ${String(plan.version)}`,
      );
    }
    if (!Array.isArray(plan.batches) || plan.batches.length === 0) {
      invalidPlan("batches must be a non-empty array");
    }
    const packageId = normalizeAddress(plan.packageId, "plan.packageId");
    const source = normalizeAddress(plan.source, "plan.source");
    const coinType = normalizeCoinType(plan.coinType);
    if (
      packageId !== plan.packageId ||
      source !== plan.source ||
      coinType !== plan.coinType
    ) {
      invalidPlan("transaction context is not normalized");
    }
    hexToBytes(plan.distributionHash, 32);
    hexToBytes(plan.planHash, 32);

    if (!plan.limits || typeof plan.limits !== "object") {
      invalidPlan("limits must be an object");
    }
    assertExactKeys(
      plan.limits,
      [
        "maxSignedTransactionBytes",
        "maxPureArgumentBytes",
        "gasPaymentCount",
        "signatureModel",
      ],
      "limits",
    );
    if (
      !plan.limits.signatureModel ||
      typeof plan.limits.signatureModel !== "object"
    ) {
      invalidPlan("signatureModel must be an object");
    }
    assertExactKeys(
      plan.limits.signatureModel,
      plan.limits.signatureModel.kind === "serialized-signatures"
        ? ["kind", "lengths"]
        : ["kind", "bytes"],
      "signatureModel",
    );
    const limits = normalizeLimits(limitsToInput(plan.limits));
    if (JSON.stringify(limits) !== JSON.stringify(plan.limits)) {
      invalidPlan("limits are not canonical");
    }

    const payouts: Payout[] = [];
    const decodedBatches: DecodedBatch[] = [];
    const recipients = new Set<string>();
    let previousPayout: Payout | undefined;
    let distributionTotal = 0n;
    for (const [batchIndex, batch] of plan.batches.entries()) {
      if (!batch || typeof batch !== "object") {
        invalidPlan(`batches[${batchIndex}] must be an object`);
      }
      assertExactKeys(
        batch,
        [
          "index",
          "startIndex",
          "endIndex",
          "packageId",
          "source",
          "coinType",
          "distributionHash",
          "recipientCount",
          "totalAmount",
          "transactionDataBytes",
          "signedTransactionBytes",
          "batchHash",
          "chunks",
        ],
        `batches[${batchIndex}]`,
      );
      planInteger(batch.index, `batches[${batchIndex}].index`);
      planInteger(batch.startIndex, `batches[${batchIndex}].startIndex`);
      planInteger(batch.endIndex, `batches[${batchIndex}].endIndex`);
      planInteger(
        batch.recipientCount,
        `batches[${batchIndex}].recipientCount`,
      );
      planInteger(
        batch.transactionDataBytes,
        `batches[${batchIndex}].transactionDataBytes`,
      );
      planInteger(
        batch.signedTransactionBytes,
        `batches[${batchIndex}].signedTransactionBytes`,
      );
      if (batch.index !== batchIndex || batch.startIndex !== payouts.length) {
        invalidPlan("batch indices are not contiguous");
      }
      if (
        batch.packageId !== packageId ||
        batch.source !== source ||
        batch.coinType !== coinType ||
        batch.distributionHash !== plan.distributionHash
      ) {
        invalidPlan(`batches[${batchIndex}] transaction context differs`);
      }
      hexToBytes(batch.batchHash, 32);
      if (
        !Array.isArray(batch.chunks) ||
        batch.chunks.length === 0 ||
        batch.chunks.length > MAX_CHUNKS_PER_BATCH
      ) {
        invalidPlan(`batches[${batchIndex}] must contain one to eight chunks`);
      }

      const chunkRanges: [number, number][] = [];
      let batchTotal = 0n;
      for (const [chunkIndex, chunk] of batch.chunks.entries()) {
        if (!chunk || typeof chunk !== "object") {
          invalidPlan(
            `batches[${batchIndex}].chunks[${chunkIndex}] must be an object`,
          );
        }
        assertExactKeys(
          chunk,
          ["recipients", "runs", "recipientCount", "totalAmount"],
          `batches[${batchIndex}].chunks[${chunkIndex}]`,
        );
        if (!Array.isArray(chunk.recipients) || chunk.recipients.length === 0) {
          invalidPlan(`batches[${batchIndex}].chunks[${chunkIndex}] is empty`);
        }
        const decoded = decodeRuns(chunk.recipients, hexToBytes(chunk.runs));
        const chunkStart = payouts.length;
        let chunkTotal = 0n;
        for (const payout of decoded) {
          if (
            payout.recipient !== chunk.recipients[payouts.length - chunkStart]
          ) {
            invalidPlan("chunk recipient addresses are not normalized");
          }
          if (recipients.has(payout.recipient)) {
            invalidPlan(`duplicate recipient ${payout.recipient}`);
          }
          recipients.add(payout.recipient);
          if (
            previousPayout &&
            (previousPayout.amount > payout.amount ||
              (previousPayout.amount === payout.amount &&
                previousPayout.recipient >= payout.recipient))
          ) {
            invalidPlan("payouts are not one global canonical sequence");
          }
          payouts.push(payout);
          previousPayout = payout;
          chunkTotal += payout.amount;
          distributionTotal += payout.amount;
          if (distributionTotal > MAX_U64) {
            invalidPlan("distribution total exceeds u64");
          }
        }
        const recipientCount = planInteger(
          chunk.recipientCount,
          `batches[${batchIndex}].chunks[${chunkIndex}].recipientCount`,
        );
        const committedTotal = planAmount(
          chunk.totalAmount,
          `batches[${batchIndex}].chunks[${chunkIndex}].totalAmount`,
        );
        if (
          recipientCount !== decoded.length ||
          committedTotal !== chunkTotal
        ) {
          invalidPlan("chunk metadata differs from its codec payload");
        }
        chunkRanges.push([chunkStart, payouts.length]);
        batchTotal += chunkTotal;
      }
      if (
        batch.endIndex !== payouts.length ||
        batch.recipientCount !== batch.endIndex - batch.startIndex ||
        planAmount(batch.totalAmount, `batches[${batchIndex}].totalAmount`) !==
          batchTotal
      ) {
        invalidPlan("batch range or total differs from its chunks");
      }
      decodedBatches.push({ batch, chunkRanges, total: batchTotal });
    }

    if (
      planInteger(plan.recipientCount, "plan.recipientCount") !==
        payouts.length ||
      planAmount(plan.totalAmount, "plan.totalAmount") !== distributionTotal
    ) {
      invalidPlan("top-level count or total differs from its batches");
    }
    const distributionHash = hashDistribution({
      packageId,
      source,
      coinType,
      payouts,
    });
    if (distributionHash !== plan.distributionHash) {
      invalidPlan("distribution hash differs");
    }

    const analysis = analyzePayouts(payouts, limits.maxPureArgumentBytes);
    const transactionSizes = createTransactionSizeModel(
      packageId,
      source,
      coinType,
      limits,
    );
    const batchHashes: string[] = [];
    for (const { batch, chunkRanges, total } of decodedBatches) {
      const candidate = candidateForRange(
        analysis,
        transactionSizes,
        batch.startIndex,
        batch.endIndex,
        limits,
      );
      if (
        !candidate ||
        !sameShapes(candidate.chunks, chunkRanges) ||
        candidate.transactionDataBytes !== batch.transactionDataBytes ||
        candidate.signedTransactionBytes !== batch.signedTransactionBytes
      ) {
        invalidPlan(`batch ${batch.index} has noncanonical chunks or sizes`);
      }
      if (
        batch.endIndex < payouts.length &&
        candidateForRange(
          analysis,
          transactionSizes,
          batch.startIndex,
          batch.endIndex + 1,
          limits,
        )
      ) {
        invalidPlan(`batch ${batch.index} is not the largest valid range`);
      }
      const batchHash = hashBatch({
        distributionHash,
        packageId,
        source,
        coinType,
        index: batch.index,
        startIndex: batch.startIndex,
        withdrawalTotal: total,
        chunks: batch.chunks,
      });
      if (batchHash !== batch.batchHash) {
        invalidPlan(`batch ${batch.index} hash differs`);
      }
      batchHashes.push(batchHash);
    }
    if (hashPlan(distributionHash, limits, batchHashes) !== plan.planHash) {
      invalidPlan("plan hash differs");
    }
    return true;
  } catch (error) {
    if (error instanceof MinatoError) throw error;
    throw new MinatoError("INVALID_PLAN", "Plan verification failed", {
      cause: error,
    });
  }
}
