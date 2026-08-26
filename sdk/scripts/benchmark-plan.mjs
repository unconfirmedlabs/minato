import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  createDistributionPlan,
  verifyDistributionPlan,
} from "../src/index.ts";

const manifestPath = process.argv[2];
if (!manifestPath) {
  throw new Error("Usage: bun run benchmark:plan <address,amount.csv> [runs]");
}
const measuredRuns = Number(process.argv[3] ?? 5);
if (!Number.isSafeInteger(measuredRuns) || measuredRuns < 1) {
  throw new Error("runs must be a positive integer");
}

const bytes = readFileSync(manifestPath);
const manifestSha256 = createHash("sha256").update(bytes).digest("hex");
const lines = bytes.toString("utf8").trim().split(/\r?\n/);
if (lines.shift() !== "address,amount") {
  throw new Error("Expected an address,amount CSV header");
}
const payouts = lines.map((line, index) => {
  const fields = line.split(",");
  if (
    fields.length !== 2 ||
    !fields[0] ||
    !/^[1-9]\d*$/.test(fields[1] ?? "")
  ) {
    throw new Error(`Invalid manifest row ${index + 2}`);
  }
  return { recipient: fields[0], amount: BigInt(fields[1]) };
});

const options = {
  packageId: process.env.MINATO_BENCHMARK_PACKAGE ?? "0x42",
  source:
    process.env.MINATO_BENCHMARK_SOURCE ??
    "0x2f8b648493a3351d13a23ff0af055a35a9aac0fbfbe698c2d2d0306c40db18ef",
  coinType:
    process.env.MINATO_BENCHMARK_COIN_TYPE ??
    "0x44f838219cf67b058f3b37907b655f226153c18e33dfcd0da559a844fea9b1c1::usdsui::USDSUI",
  payouts,
  limits: {
    maxSignedTransactionBytes: 131_072,
    maxPureArgumentBytes: 16_384,
    gasPaymentCount: 1,
    signatureLengths: [97],
  },
};

function identity(plan) {
  return JSON.stringify({
    distributionHash: plan.distributionHash,
    planHash: plan.planHash,
    boundaries: plan.batches.map((batch) => batch.endIndex),
    batchHashes: plan.batches.map((batch) => batch.batchHash),
  });
}

function run() {
  const started = performance.now();
  const plan = createDistributionPlan(options);
  const planned = performance.now();
  if (!verifyDistributionPlan(plan))
    throw new Error("Plan verification failed");
  const verified = performance.now();
  return {
    plan,
    planMs: planned - started,
    verifyMs: verified - planned,
    identity: identity(plan),
  };
}

run(); // Warm JITs and filesystem-independent module initialization.
const results = Array.from({ length: measuredRuns }, run);
const expectedIdentity = results[0].identity;
if (results.some((result) => result.identity !== expectedIdentity)) {
  throw new Error("Planner output changed between benchmark runs");
}
const plan = results[0].plan;

function summarize(values) {
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  const median =
    ordered.length % 2 === 0
      ? (ordered[middle - 1] + ordered[middle]) / 2
      : ordered[middle];
  return {
    medianMs: Number(median.toFixed(3)),
    minMs: Number(ordered[0].toFixed(3)),
    maxMs: Number(ordered.at(-1).toFixed(3)),
  };
}

console.log(
  JSON.stringify(
    {
      runtime: `Bun ${Bun.version}`,
      manifest: {
        path: manifestPath,
        sha256: manifestSha256,
        recipients: plan.recipientCount,
        totalAmount: plan.totalAmount,
      },
      result: {
        distributionHash: plan.distributionHash,
        planHash: plan.planHash,
        batches: plan.batches.length,
        maxRecipients: Math.max(
          ...plan.batches.map((batch) => batch.recipientCount),
        ),
        maxTransactionDataBytes: Math.max(
          ...plan.batches.map((batch) => batch.transactionDataBytes),
        ),
        maxSignedTransactionBytes: Math.max(
          ...plan.batches.map((batch) => batch.signedTransactionBytes),
        ),
      },
      timing: {
        measuredRuns,
        plan: summarize(results.map((result) => result.planMs)),
        verify: summarize(results.map((result) => result.verifyMs)),
      },
    },
    null,
    2,
  ),
);
