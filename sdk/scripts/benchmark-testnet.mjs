import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { bcs } from "@mysten/sui/bcs";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Secp256k1Keypair } from "@mysten/sui/keypairs/secp256k1";
import { Secp256r1Keypair } from "@mysten/sui/keypairs/secp256r1";
import { TransactionDataBuilder } from "@mysten/sui/transactions";
import {
  createDistributionPlan,
  createMinatoTx,
  verifyDistributionPlan,
} from "../src/index.ts";

const DEFAULT_RPC = "https://fullnode.testnet.sui.io:443";
const DEFAULT_PACKAGE =
  "0x24322ee84beea9938c492815585c5b6587607f264dcc52c00a49873a8c3e2d37";
const DEFAULT_SOURCE =
  "0x35f5f154f0117464e3379c45c7f3cb6b2d4efedf300acadff8a7e8e9e3a15109";
const DEFAULT_SEED = "minato-testnet-100k-v1";
const SUI = "0x2::sui::SUI";

const execute = process.argv.includes("--execute");
const outputIndex = process.argv.indexOf("--output");
const outputPath = outputIndex === -1 ? null : process.argv[outputIndex + 1];
if (outputIndex !== -1 && !outputPath) {
  throw new Error("--output requires a path");
}

const rpc = process.env.MINATO_TESTNET_RPC ?? DEFAULT_RPC;
const packageId = process.env.MINATO_TESTNET_PACKAGE ?? DEFAULT_PACKAGE;
const source = process.env.MINATO_TESTNET_SOURCE ?? DEFAULT_SOURCE;
const seed = process.env.MINATO_TESTNET_SEED ?? DEFAULT_SEED;
const recipientCount = Number(
  process.env.MINATO_TESTNET_RECIPIENTS ?? "100000",
);
if (!Number.isSafeInteger(recipientCount) || recipientCount < 1) {
  throw new Error("MINATO_TESTNET_RECIPIENTS must be a positive safe integer");
}

function keypairFromEntry(encoded) {
  let decoded;
  try {
    decoded = decodeSuiPrivateKey(encoded);
  } catch {
    const raw = Uint8Array.from(Buffer.from(encoded, "base64"));
    if (raw.length !== 33 || raw[0] > 2) {
      throw new Error("Unsupported legacy Sui keystore entry");
    }
    decoded = {
      scheme: ["ED25519", "Secp256k1", "Secp256r1"][raw[0]],
      secretKey: raw.slice(1),
    };
  }
  if (decoded.scheme === "ED25519") {
    return Ed25519Keypair.fromSecretKey(decoded.secretKey);
  }
  if (decoded.scheme === "Secp256k1") {
    return Secp256k1Keypair.fromSecretKey(decoded.secretKey);
  }
  if (decoded.scheme === "Secp256r1") {
    return Secp256r1Keypair.fromSecretKey(decoded.secretKey);
  }
  throw new Error(`Unsupported key scheme ${decoded.scheme}`);
}

function loadSigner(address) {
  const path =
    process.env.SUI_KEYSTORE ??
    join(homedir(), ".sui", "sui_config", "sui.keystore");
  const entries = JSON.parse(readFileSync(path, "utf8"));
  for (const entry of entries) {
    const keypair = keypairFromEntry(entry);
    if (keypair.toSuiAddress() === address) return keypair;
  }
  throw new Error(`No local keystore key for ${address}`);
}

function makePayouts() {
  return Array.from({ length: recipientCount }, (_, index) => ({
    recipient: `0x${createHash("sha256")
      .update(`${seed}:${index}`)
      .digest("hex")}`,
    amount: 1n,
  }));
}

function signedEnvelopeLength(transactionBytes, signatureBytes) {
  return bcs.SenderSignedData.serialize([
    {
      intentMessage: {
        intent: {
          scope: { TransactionData: true },
          version: { V0: true },
          appId: { Sui: true },
        },
        value: bcs.TransactionData.parse(transactionBytes),
      },
      txSignatures: [signatureBytes],
    },
  ]).toBytes().length;
}

function gasSummary(gasUsed) {
  const computation = BigInt(gasUsed.computationCost);
  const storage = BigInt(gasUsed.storageCost);
  const rebate = BigInt(gasUsed.storageRebate);
  return {
    computationCost: computation.toString(),
    storageCost: storage.toString(),
    storageRebate: rebate.toString(),
    nonRefundableStorageFee: gasUsed.nonRefundableStorageFee,
    netCost: (computation + storage - rebate).toString(),
  };
}

function persist(result) {
  if (outputPath)
    writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`);
}

async function balances(client, addresses) {
  return Promise.all(
    addresses.map(async (address) => ({
      address,
      balance: (await client.core.getBalance({ owner: address, coinType: SUI }))
        .balance.balance,
    })),
  );
}

async function waitForSampleDeltas(client, before, delta) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const after = await balances(
      client,
      before.map((sample) => sample.address),
    );
    if (
      after.every(
        (sample, index) =>
          BigInt(sample.balance) - BigInt(before[index].balance) === delta,
      )
    ) {
      return after;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error("Timed out waiting for sampled recipient balances");
}

async function waitForSourceDelta(client, before, delta) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const after = (
      await client.core.getBalance({ owner: source, coinType: SUI })
    ).balance;
    if (
      BigInt(before.addressBalance) - BigInt(after.addressBalance) ===
      delta
    ) {
      return after;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error("Timed out waiting for the source address balance");
}

async function executeExact(client, transaction, signatures, digest) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await client.core.executeTransaction({
        transaction,
        signatures,
        include: { effects: true },
      });
    } catch (error) {
      lastError = error;
      try {
        return await client.core.getTransaction({
          digest,
          include: { effects: true },
        });
      } catch {
        if (attempt < 2) {
          await new Promise((resolve) =>
            setTimeout(resolve, 1_000 * 2 ** attempt),
          );
        }
      }
    }
  }
  throw lastError;
}

const client = new SuiGrpcClient({ network: "testnet", baseUrl: rpc });
const [protocol, gasPrice, balanceBefore] = await Promise.all([
  client.core.getProtocolConfig(),
  client.core.getReferenceGasPrice(),
  client.core.getBalance({ owner: source, coinType: SUI }),
]);
const attributes = protocol.protocolConfig.attributes;
const limits = {
  maxSignedTransactionBytes: Number(attributes.max_tx_size_bytes),
  maxPureArgumentBytes: Number(attributes.max_pure_argument_size),
  gasPaymentCount: 0,
  signatureLengths: [97],
};
if (
  !Number.isSafeInteger(limits.maxSignedTransactionBytes) ||
  !Number.isSafeInteger(limits.maxPureArgumentBytes)
) {
  throw new Error("Testnet did not return usable transaction limits");
}

const payouts = makePayouts();
const sampleAddresses = [
  0,
  Math.floor((recipientCount - 1) / 3),
  Math.floor(((recipientCount - 1) * 2) / 3),
  recipientCount - 1,
]
  .filter((value, index, values) => values.indexOf(value) === index)
  .map((index) => payouts[index].recipient);
const sampleBalancesBefore = await balances(client, sampleAddresses);
const planStarted = performance.now();
const plan = createDistributionPlan({
  packageId,
  source,
  coinType: SUI,
  payouts,
  limits,
});
const planFinished = performance.now();
verifyDistributionPlan(plan);
const verifyFinished = performance.now();

const signer = execute ? loadSigner(source) : null;
if (signer && signer.getKeyScheme() !== "ED25519") {
  throw new Error("This benchmark commits to one 97-byte Ed25519 signature");
}
const minimumBalance = BigInt(plan.totalAmount);
if (BigInt(balanceBefore.balance.addressBalance) < minimumBalance) {
  throw new Error(
    `Address balance ${balanceBefore.balance.addressBalance} is below payout total ${minimumBalance}`,
  );
}

const result = {
  schema: "minato/testnet-benchmark/v1",
  mode: execute ? "execute" : "simulate",
  network: "testnet",
  rpc,
  packageId: plan.packageId,
  source: plan.source,
  coinType: plan.coinType,
  protocolVersion: protocol.protocolConfig.protocolVersion,
  referenceGasPrice: gasPrice.referenceGasPrice,
  seed,
  recipientCount: plan.recipientCount,
  amountPerRecipient: "1",
  totalAmount: plan.totalAmount,
  distributionHash: plan.distributionHash,
  planHash: plan.planHash,
  limits: plan.limits,
  planning: {
    planMs: planFinished - planStarted,
    verifyMs: verifyFinished - planFinished,
  },
  balanceBefore: balanceBefore.balance,
  sampleBalancesBefore,
  batches: [],
};
persist(result);

for (const batch of plan.batches) {
  const transaction = createMinatoTx(packageId).disperseWithdrawal({ batch });
  const buildStarted = performance.now();
  const transactionBytes = await transaction.build({ client });
  const buildMs = performance.now() - buildStarted;
  if (transactionBytes.length !== batch.transactionDataBytes) {
    throw new Error(
      `Batch ${batch.index} planned ${batch.transactionDataBytes} transaction bytes, resolved ${transactionBytes.length}`,
    );
  }
  const digest = TransactionDataBuilder.getDigestFromBytes(transactionBytes);
  let signature;
  let signatureBytes;
  if (signer) {
    ({ signature } = await signer.signTransaction(transactionBytes));
    signatureBytes = Uint8Array.from(Buffer.from(signature, "base64"));
    const actualSignedBytes = signedEnvelopeLength(
      transactionBytes,
      signatureBytes,
    );
    if (actualSignedBytes !== batch.signedTransactionBytes) {
      throw new Error(
        `Batch ${batch.index} planned ${batch.signedTransactionBytes} signed bytes, resolved ${actualSignedBytes}`,
      );
    }
  }

  const simulationStarted = performance.now();
  const simulation = await client.core.simulateTransaction({
    transaction: transactionBytes,
    include: { effects: true },
  });
  const simulationMs = performance.now() - simulationStarted;
  if (simulation.$kind === "FailedTransaction") {
    throw new Error(
      `Batch ${batch.index} simulation failed: ${simulation.FailedTransaction.status.error?.message ?? "unknown error"}`,
    );
  }

  const batchResult = {
    index: batch.index,
    batchHash: batch.batchHash,
    recipients: batch.recipientCount,
    transactionDataBytes: batch.transactionDataBytes,
    signedTransactionBytes: batch.signedTransactionBytes,
    digest,
    buildMs,
    simulationMs,
    simulatedGas: gasSummary(simulation.Transaction.effects.gasUsed),
  };

  if (execute) {
    const executionStarted = performance.now();
    const execution = await executeExact(
      client,
      transactionBytes,
      [signature],
      digest,
    );
    const executionMs = performance.now() - executionStarted;
    if (execution.$kind === "FailedTransaction") {
      throw new Error(
        `Batch ${batch.index} execution failed: ${execution.FailedTransaction.status.error?.message ?? "unknown error"}`,
      );
    }
    if (execution.Transaction.digest !== digest) {
      throw new Error(`Batch ${batch.index} returned an unexpected digest`);
    }
    batchResult.executionMs = executionMs;
    batchResult.executedGas = gasSummary(execution.Transaction.effects.gasUsed);
  }

  result.batches.push(batchResult);
  persist(result);
  console.log(
    JSON.stringify({
      batch: batch.index,
      recipients: batch.recipientCount,
      digest,
      simulatedGas: batchResult.simulatedGas.netCost,
      executionMs: batchResult.executionMs ?? null,
    }),
  );
}

result.sampleBalancesAfter = execute
  ? await waitForSampleDeltas(client, sampleBalancesBefore, 1n)
  : await balances(client, sampleAddresses);
const executedNetGas = execute
  ? result.batches.reduce(
      (sum, batch) => sum + BigInt(batch.executedGas.netCost),
      0n,
    )
  : null;
result.balanceAfter = execute
  ? await waitForSourceDelta(
      client,
      balanceBefore.balance,
      executedNetGas + BigInt(plan.totalAmount),
    )
  : (await client.core.getBalance({ owner: source, coinType: SUI })).balance;
result.totals = {
  batches: result.batches.length,
  recipients: result.batches.reduce((sum, batch) => sum + batch.recipients, 0),
  transactionDataBytes: result.batches.reduce(
    (sum, batch) => sum + batch.transactionDataBytes,
    0,
  ),
  signedTransactionBytes: result.batches.reduce(
    (sum, batch) => sum + batch.signedTransactionBytes,
    0,
  ),
  simulatedNetGas: result.batches
    .reduce((sum, batch) => sum + BigInt(batch.simulatedGas.netCost), 0n)
    .toString(),
  executedNetGas: execute ? executedNetGas.toString() : null,
  buildMs: result.batches.reduce((sum, batch) => sum + batch.buildMs, 0),
  simulationMs: result.batches.reduce(
    (sum, batch) => sum + batch.simulationMs,
    0,
  ),
  executionMs: execute
    ? result.batches.reduce((sum, batch) => sum + batch.executionMs, 0)
    : null,
};
result.completedAt = new Date().toISOString();
persist(result);
console.log(JSON.stringify(result, null, 2));
