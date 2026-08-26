import { sha256 } from "@noble/hashes/sha2.js";
import { HASH_DOMAINS } from "./constants.js";
import { bytesToHex, ulebLength } from "./internal.js";
import type { DistributionChunk, LimitSnapshot, Payout } from "./types.js";

const textEncoder = new TextEncoder();

function utf8(value: string): Uint8Array {
  return textEncoder.encode(value);
}

function hexByteLength(value: string, expectedLength?: number): number {
  if (typeof value !== "string" || !/^0x(?:[0-9a-f]{2})*$/.test(value)) {
    throw new Error("Expected lowercase 0x-prefixed, byte-aligned hex");
  }
  const length = (value.length - 2) / 2;
  if (expectedLength !== undefined && length !== expectedLength) {
    throw new Error(`Expected ${expectedLength} bytes, received ${length}`);
  }
  return length;
}

class BcsWriter {
  readonly #bytes: Uint8Array;
  readonly #view: DataView;
  #offset = 0;

  constructor(length: number) {
    this.#bytes = new Uint8Array(length);
    this.#view = new DataView(this.#bytes.buffer);
  }

  writeUleb(value: number): void {
    let remaining = value;
    do {
      let byte = remaining % 0x80;
      remaining = Math.floor(remaining / 0x80);
      if (remaining !== 0) byte |= 0x80;
      this.#bytes[this.#offset++] = byte;
    } while (remaining !== 0);
  }

  writeU32(value: number): void {
    this.#view.setUint32(this.#offset, value, true);
    this.#offset += 4;
  }

  writeU64(value: bigint | number): void {
    this.#view.setBigUint64(this.#offset, BigInt(value), true);
    this.#offset += 8;
  }

  writeBytes(bytes: Uint8Array): void {
    this.#bytes.set(bytes, this.#offset);
    this.#offset += bytes.length;
  }

  writeHex(value: string, expectedLength?: number): void {
    const length = hexByteLength(value, expectedLength);
    for (let index = 0; index < length; index += 1) {
      this.#bytes[this.#offset++] = Number.parseInt(
        value.slice(2 + index * 2, 4 + index * 2),
        16,
      );
    }
  }

  writeString(bytes: Uint8Array): void {
    this.writeUleb(bytes.length);
    this.writeBytes(bytes);
  }

  finish(): Uint8Array {
    if (this.#offset !== this.#bytes.length) {
      throw new Error(
        `Internal BCS size mismatch: wrote ${this.#offset} of ${this.#bytes.length} bytes`,
      );
    }
    return this.#bytes;
  }
}

function domainHash(domain: string, payload: Uint8Array): string {
  const hash = sha256.create();
  hash.update(utf8(`${domain}\0`));
  hash.update(payload);
  return bytesToHex(hash.digest());
}

function stringSize(bytes: Uint8Array): number {
  return ulebLength(bytes.length) + bytes.length;
}

function chunkSize(chunk: DistributionChunk): number {
  const runsLength = hexByteLength(chunk.runs);
  return (
    ulebLength(chunk.recipients.length) +
    chunk.recipients.length * 32 +
    ulebLength(runsLength) +
    runsLength
  );
}

function writeChunk(writer: BcsWriter, chunk: DistributionChunk): void {
  writer.writeUleb(chunk.recipients.length);
  for (const recipient of chunk.recipients) writer.writeHex(recipient, 32);
  const runsLength = hexByteLength(chunk.runs);
  writer.writeUleb(runsLength);
  writer.writeHex(chunk.runs);
}

export function hashDistribution(options: {
  packageId: string;
  source: string;
  coinType: string;
  payouts: readonly Payout[];
}): string {
  const coinType = utf8(options.coinType);
  const writer = new BcsWriter(
    32 +
      32 +
      stringSize(coinType) +
      ulebLength(options.payouts.length) +
      options.payouts.length * (32 + 8),
  );
  writer.writeHex(options.packageId, 32);
  writer.writeHex(options.source, 32);
  writer.writeString(coinType);
  writer.writeUleb(options.payouts.length);
  for (const payout of options.payouts) {
    writer.writeHex(payout.recipient, 32);
    writer.writeU64(payout.amount);
  }
  return domainHash(HASH_DOMAINS.distribution, writer.finish());
}

export function hashBatch(options: {
  distributionHash: string;
  packageId: string;
  source: string;
  coinType: string;
  index: number;
  startIndex: number;
  withdrawalTotal: bigint;
  chunks: readonly DistributionChunk[];
}): string {
  const coinType = utf8(options.coinType);
  const writer = new BcsWriter(
    32 +
      32 +
      32 +
      stringSize(coinType) +
      4 +
      8 +
      8 +
      ulebLength(options.chunks.length) +
      options.chunks.reduce((size, chunk) => size + chunkSize(chunk), 0),
  );
  writer.writeHex(options.distributionHash, 32);
  writer.writeHex(options.packageId, 32);
  writer.writeHex(options.source, 32);
  writer.writeString(coinType);
  writer.writeU32(options.index);
  writer.writeU64(options.startIndex);
  writer.writeU64(options.withdrawalTotal);
  writer.writeUleb(options.chunks.length);
  for (const chunk of options.chunks) writeChunk(writer, chunk);
  return domainHash(HASH_DOMAINS.batch, writer.finish());
}

function signatureModelSize(limits: LimitSnapshot): number {
  return limits.signatureModel.kind === "serialized-signatures"
    ? 1 +
        ulebLength(limits.signatureModel.lengths.length) +
        limits.signatureModel.lengths.length * 4
    : 1 + 8;
}

export function hashPlan(
  distributionHash: string,
  limits: LimitSnapshot,
  batchHashes: readonly string[],
): string {
  const writer = new BcsWriter(
    32 +
      8 +
      8 +
      4 +
      signatureModelSize(limits) +
      ulebLength(batchHashes.length) +
      batchHashes.length * 32,
  );
  writer.writeHex(distributionHash, 32);
  writer.writeU64(limits.maxSignedTransactionBytes);
  writer.writeU64(limits.maxPureArgumentBytes);
  writer.writeU32(limits.gasPaymentCount);
  if (limits.signatureModel.kind === "serialized-signatures") {
    writer.writeUleb(0);
    writer.writeUleb(limits.signatureModel.lengths.length);
    for (const length of limits.signatureModel.lengths) writer.writeU32(length);
  } else {
    writer.writeUleb(1);
    writer.writeU64(limits.signatureModel.bytes);
  }
  writer.writeUleb(batchHashes.length);
  for (const batchHash of batchHashes) writer.writeHex(batchHash, 32);
  return domainHash(HASH_DOMAINS.plan, writer.finish());
}
