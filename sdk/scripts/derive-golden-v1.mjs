// Golden-vector oracle for Minato v1.
//
// This file deliberately does not import Minato source code. Hash payloads are
// encoded twice (once by the small BCS encoder below and once by @mysten/sui),
// while the PTB is assembled directly from Sui's public Transaction API.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { bcs } from "@mysten/sui/bcs";
import { Transaction, TransactionDataBuilder } from "@mysten/sui/transactions";

const ZERO_DIGEST = "11111111111111111111111111111111";
const textEncoder = new TextEncoder();

function concat(...parts) {
  const length = parts.reduce((sum, part) => sum + part.length, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function hex(bytes) {
  return `0x${Buffer.from(bytes).toString("hex")}`;
}

function normalizeAddress(address) {
  const value = address.toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]{1,64}$/.test(value))
    throw new Error(`Invalid address ${address}`);
  return `0x${value.padStart(64, "0")}`;
}

function address(addressValue) {
  return Uint8Array.from(
    Buffer.from(normalizeAddress(addressValue).slice(2), "hex"),
  );
}

function uleb(value) {
  let remaining = BigInt(value);
  if (remaining < 0n) throw new Error("ULEB128 cannot encode a negative value");
  const result = [];
  do {
    let byte = Number(remaining & 0x7fn);
    remaining >>= 7n;
    if (remaining !== 0n) byte |= 0x80;
    result.push(byte);
  } while (remaining !== 0n);
  return Uint8Array.from(result);
}

function littleEndian(value, byteLength) {
  let remaining = BigInt(value);
  const result = new Uint8Array(byteLength);
  for (let index = 0; index < byteLength; index += 1) {
    result[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  if (remaining !== 0n)
    throw new Error(`${value} does not fit in ${byteLength} bytes`);
  return result;
}

function vector(values, encode) {
  return concat(uleb(values.length), ...values.map(encode));
}

function bytes(value) {
  return concat(uleb(value.length), value);
}

function string(value) {
  return bytes(textEncoder.encode(value));
}

function encodeRuns(payouts) {
  const groups = [];
  for (const payout of payouts) {
    const amount = BigInt(payout.amount);
    const last = groups.at(-1);
    if (last?.amount === amount) last.count += 1n;
    else groups.push({ amount, count: 1n });
  }
  const result = [uleb(groups.length)];
  let previous = 0n;
  for (const group of groups) {
    result.push(uleb(group.amount - previous), uleb(group.count));
    previous = group.amount;
  }
  return concat(...result);
}

function domainHash(domain, payload) {
  return `0x${createHash("sha256")
    .update(textEncoder.encode(`${domain}\0`))
    .update(payload)
    .digest("hex")}`;
}

function assertBytesEqual(label, left, right) {
  if (hex(left) !== hex(right)) {
    throw new Error(
      `${label} encoders disagree:\nmanual=${hex(left)}\nSui=${hex(right)}`,
    );
  }
}

const packageId = normalizeAddress("0x42");
const source = normalizeAddress("0x99");
const coinTypeInput = "0x2::sui::SUI";
const coinType = `${normalizeAddress("0x2")}::sui::SUI`;
const payouts = [
  { recipient: normalizeAddress("0x1"), amount: "1" },
  { recipient: normalizeAddress("0x2"), amount: "2" },
];
const chunks = [
  {
    recipients: payouts.map((payout) => payout.recipient),
    runs: encodeRuns(payouts),
  },
];
const limits = {
  maxSignedTransactionBytes: 4096,
  maxPureArgumentBytes: 1024,
  gasPaymentCount: 1,
  signatureLengths: [97],
};

const payoutManual = (payout) =>
  concat(address(payout.recipient), littleEndian(payout.amount, 8));
const distributionPayload = concat(
  address(packageId),
  address(source),
  string(coinType),
  vector(payouts, payoutManual),
);

const PayoutSchema = bcs.struct("GoldenPayoutV1", {
  recipient: bcs.Address,
  amount: bcs.U64,
});
const DistributionSchema = bcs.struct("GoldenDistributionV1", {
  packageId: bcs.Address,
  source: bcs.Address,
  coinType: bcs.String,
  payouts: bcs.vector(PayoutSchema),
});
assertBytesEqual(
  "distribution payload",
  distributionPayload,
  DistributionSchema.serialize({
    packageId,
    source,
    coinType,
    payouts: payouts.map((payout) => ({
      ...payout,
      amount: BigInt(payout.amount),
    })),
  }).toBytes(),
);
const distributionHash = domainHash(
  "minato/distribution/v1",
  distributionPayload,
);

const chunkManual = (chunk) =>
  concat(vector(chunk.recipients, address), bytes(chunk.runs));
const batchPayload = concat(
  Uint8Array.from(Buffer.from(distributionHash.slice(2), "hex")),
  address(packageId),
  address(source),
  string(coinType),
  littleEndian(0, 4),
  littleEndian(0, 8),
  littleEndian(3, 8),
  vector(chunks, chunkManual),
);
const ChunkSchema = bcs.struct("GoldenChunkV1", {
  recipients: bcs.vector(bcs.Address),
  runs: bcs.vector(bcs.U8),
});
const BatchSchema = bcs.struct("GoldenBatchV1", {
  distributionHash: bcs.bytes(32),
  packageId: bcs.Address,
  source: bcs.Address,
  coinType: bcs.String,
  index: bcs.U32,
  startIndex: bcs.U64,
  withdrawalTotal: bcs.U64,
  chunks: bcs.vector(ChunkSchema),
});
assertBytesEqual(
  "batch payload",
  batchPayload,
  BatchSchema.serialize({
    distributionHash: Uint8Array.from(
      Buffer.from(distributionHash.slice(2), "hex"),
    ),
    packageId,
    source,
    coinType,
    index: 0,
    startIndex: 0,
    withdrawalTotal: 3n,
    chunks: chunks.map((chunk) => ({
      recipients: chunk.recipients,
      runs: chunk.runs,
    })),
  }).toBytes(),
);
const batchHash = domainHash("minato/batch/v1", batchPayload);

const limitsPayload = concat(
  littleEndian(limits.maxSignedTransactionBytes, 8),
  littleEndian(limits.maxPureArgumentBytes, 8),
  littleEndian(limits.gasPaymentCount, 4),
  uleb(0),
  vector(limits.signatureLengths, (length) => littleEndian(length, 4)),
);
const planPayload = concat(
  Uint8Array.from(Buffer.from(distributionHash.slice(2), "hex")),
  limitsPayload,
  vector([batchHash], (hash) =>
    Uint8Array.from(Buffer.from(hash.slice(2), "hex")),
  ),
);
const SignatureModelSchema = bcs.enum("GoldenSignatureModelV1", {
  SerializedSignatures: bcs.vector(bcs.U32),
  FixedOverhead: bcs.U64,
});
const LimitSchema = bcs.struct("GoldenLimitsV1", {
  maxSignedTransactionBytes: bcs.U64,
  maxPureArgumentBytes: bcs.U64,
  gasPaymentCount: bcs.U32,
  signatureModel: SignatureModelSchema,
});
const PlanSchema = bcs.struct("GoldenPlanV1", {
  distributionHash: bcs.bytes(32),
  limits: LimitSchema,
  batchHashes: bcs.vector(bcs.bytes(32)),
});
assertBytesEqual(
  "plan payload",
  planPayload,
  PlanSchema.serialize({
    distributionHash: Uint8Array.from(
      Buffer.from(distributionHash.slice(2), "hex"),
    ),
    limits: {
      maxSignedTransactionBytes: limits.maxSignedTransactionBytes,
      maxPureArgumentBytes: limits.maxPureArgumentBytes,
      gasPaymentCount: limits.gasPaymentCount,
      signatureModel: { SerializedSignatures: limits.signatureLengths },
    },
    batchHashes: [Uint8Array.from(Buffer.from(batchHash.slice(2), "hex"))],
  }).toBytes(),
);
const planHash = domainHash("minato/plan/v1", planPayload);
const fixedOverheadLimits = {
  maxSignedTransactionBytes: 4096,
  maxPureArgumentBytes: 1024,
  gasPaymentCount: 1,
  signatureOverheadBytes: 512,
};
const fixedOverheadLimitsPayload = concat(
  littleEndian(fixedOverheadLimits.maxSignedTransactionBytes, 8),
  littleEndian(fixedOverheadLimits.maxPureArgumentBytes, 8),
  littleEndian(fixedOverheadLimits.gasPaymentCount, 4),
  uleb(1),
  littleEndian(fixedOverheadLimits.signatureOverheadBytes, 8),
);
const fixedOverheadPlanPayload = concat(
  Uint8Array.from(Buffer.from(distributionHash.slice(2), "hex")),
  fixedOverheadLimitsPayload,
  vector([batchHash], (hash) =>
    Uint8Array.from(Buffer.from(hash.slice(2), "hex")),
  ),
);
assertBytesEqual(
  "fixed-overhead plan payload",
  fixedOverheadPlanPayload,
  PlanSchema.serialize({
    distributionHash: Uint8Array.from(
      Buffer.from(distributionHash.slice(2), "hex"),
    ),
    limits: {
      maxSignedTransactionBytes: fixedOverheadLimits.maxSignedTransactionBytes,
      maxPureArgumentBytes: fixedOverheadLimits.maxPureArgumentBytes,
      gasPaymentCount: fixedOverheadLimits.gasPaymentCount,
      signatureModel: {
        FixedOverhead: fixedOverheadLimits.signatureOverheadBytes,
      },
    },
    batchHashes: [Uint8Array.from(Buffer.from(batchHash.slice(2), "hex"))],
  }).toBytes(),
);
const fixedOverheadPlanHash = domainHash(
  "minato/plan/v1",
  fixedOverheadPlanPayload,
);

const transaction = new Transaction();
transaction.setSender(source);
const withdrawal = transaction.withdrawal({ amount: 3n, type: coinType });
const arguments_ = [withdrawal];
for (let index = 0; index < 8; index += 1) {
  const chunk = chunks[index];
  const recipients = chunk?.recipients ?? [];
  const runs = chunk?.runs ?? new Uint8Array();
  arguments_.push(
    transaction.pure(bcs.vector(bcs.Address).serialize(recipients)),
    transaction.pure(bcs.vector(bcs.U8).serialize(runs)),
  );
}
transaction.moveCall({
  target: `${packageId}::minato::disperse_withdrawal`,
  typeArguments: [coinType],
  arguments: arguments_,
});
transaction.setGasPrice(1);
transaction.setGasBudget(1);
transaction.setGasPayment([
  { objectId: "0x1", version: "1", digest: ZERO_DIGEST },
]);
const transactionData = new TransactionDataBuilder(
  transaction.getData(),
).build();

const signature = Uint8Array.from({ length: 97 }, (_, index) => index);
const signedEnvelope = concat(
  uleb(1),
  Uint8Array.of(0, 0, 0),
  transactionData,
  uleb(1),
  bytes(signature),
);
const parsedTransactionData = bcs.TransactionData.parse(transactionData);
const officialSignedEnvelope = bcs.SenderSignedData.serialize([
  {
    intentMessage: {
      intent: {
        scope: { TransactionData: true },
        version: { V0: true },
        appId: { Sui: true },
      },
      value: parsedTransactionData,
    },
    txSignatures: [signature],
  },
]).toBytes();
assertBytesEqual("signed envelope", signedEnvelope, officialSignedEnvelope);

const codecInputs = [
  { name: "one", amounts: ["1"] },
  {
    name: "uleb-boundaries",
    amounts: ["127", "128", "16383", "16384", "4294967295"],
  },
  { name: "mixed-runs", amounts: ["1", "1", "128", "128", "16384"] },
  { name: "u64-max", amounts: ["18446744073709551615"] },
];
const codec = codecInputs.map((input) => {
  const codecPayouts = input.amounts.map((amount, index) => ({
    recipient: normalizeAddress(`0x${(index + 1).toString(16)}`),
    amount,
  }));
  return {
    name: input.name,
    payouts: codecPayouts,
    runsHex: hex(encodeRuns(codecPayouts)),
  };
});
const codecPatterns = [
  {
    name: "run-count-128",
    recipientCount: 128,
    amountPattern: { kind: "constant", value: "7" },
  },
  {
    name: "group-count-128",
    recipientCount: 128,
    amountPattern: { kind: "sequence", start: "1" },
  },
].map((input) => {
  const patternPayouts = Array.from(
    { length: input.recipientCount },
    (_, index) => ({
      recipient: normalizeAddress(`0x${(index + 1).toString(16)}`),
      amount:
        input.amountPattern.kind === "constant"
          ? input.amountPattern.value
          : (BigInt(input.amountPattern.start) + BigInt(index)).toString(),
    }),
  );
  return { ...input, runsHex: hex(encodeRuns(patternPayouts)) };
});

const output = {
  format: "minato-golden-v1",
  provenance: {
    minatoImports: false,
    manualBcsCrossCheckedWith: "@mysten/sui@2.17.0",
    hashImplementation: "node:crypto SHA-256",
    transactionConstruction: "direct @mysten/sui Transaction API",
  },
  uleb128: [
    0n,
    1n,
    127n,
    128n,
    16383n,
    16384n,
    4294967295n,
    18446744073709551615n,
  ].map((value) => ({ value: value.toString(), hex: hex(uleb(value)) })),
  codec,
  codecPatterns,
  plan: {
    input: {
      packageId: "0x42",
      source: "0x99",
      coinType: coinTypeInput,
      payouts,
      limits,
    },
    canonical: {
      packageId,
      source,
      coinType,
      chunks: chunks.map((chunk) => ({
        recipients: chunk.recipients,
        runsHex: hex(chunk.runs),
        recipientCount: chunk.recipients.length,
        totalAmount: "3",
      })),
    },
    payloads: {
      distributionHex: hex(distributionPayload),
      batchHex: hex(batchPayload),
      planHex: hex(planPayload),
    },
    hashes: { distributionHash, batchHash, planHash },
    fixedOverhead: {
      limits: fixedOverheadLimits,
      planPayloadHex: hex(fixedOverheadPlanPayload),
      planHash: fixedOverheadPlanHash,
      signedTransactionBytes:
        transactionData.length + fixedOverheadLimits.signatureOverheadBytes,
    },
    transaction: {
      transactionDataHex: hex(transactionData),
      transactionDataBytes: transactionData.length,
      transactionDataSha256: `0x${createHash("sha256").update(transactionData).digest("hex")}`,
      signedEnvelopeHex: hex(signedEnvelope),
      signedEnvelopeBytes: signedEnvelope.length,
      signedEnvelopeSha256: `0x${createHash("sha256").update(signedEnvelope).digest("hex")}`,
      inputCount: transaction.getData().inputs.length,
      commandCount: transaction.getData().commands.length,
      moveCallArgumentCount:
        transaction.getData().commands[0].MoveCall.arguments.length,
    },
  },
};

const rendered = `${JSON.stringify(output, null, 2)}\n`;
if (process.argv.includes("--check")) {
  const fixtureUrl = new URL("../golden/v1.json", import.meta.url);
  const fixture = readFileSync(fixtureUrl, "utf8");
  if (JSON.stringify(JSON.parse(fixture)) !== JSON.stringify(output)) {
    throw new Error(
      "golden/v1.json is stale; run `bun run golden:derive` and apply the reviewed output",
    );
  }
  process.stdout.write("golden/v1.json independently verified\n");
} else {
  process.stdout.write(rendered);
}
