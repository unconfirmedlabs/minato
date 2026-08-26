import { MAX_U64 } from "./constants.js";
import { MinatoError } from "./errors.js";
import { normalizeAddress } from "./internal.js";
import type { Payout, PayoutInput } from "./types.js";

function invalidRuns(message: string): never {
  throw new MinatoError("INVALID_RUNS", message);
}

function encodeUleb128(value: bigint): number[] {
  if (value < 0n || value > MAX_U64)
    invalidRuns("ULEB128 value is outside u64");
  const bytes: number[] = [];
  let remaining = value;
  do {
    let byte = Number(remaining & 0x7fn);
    remaining >>= 7n;
    if (remaining !== 0n) byte |= 0x80;
    bytes.push(byte);
  } while (remaining !== 0n);
  return bytes;
}

function readUleb128(bytes: Uint8Array, state: { offset: number }): bigint {
  let value = 0n;
  for (let byteIndex = 0; byteIndex < 10; byteIndex += 1) {
    if (state.offset >= bytes.length) invalidRuns("Truncated ULEB128 value");
    const byte = bytes[state.offset++];
    if (byte === undefined) invalidRuns("Truncated ULEB128 value");
    const payload = BigInt(byte & 0x7f);
    if (byteIndex === 9 && payload > 1n)
      invalidRuns("ULEB128 value overflows u64");
    value |= payload << BigInt(byteIndex * 7);
    if ((byte & 0x80) === 0) {
      if (byteIndex > 0 && payload === 0n)
        invalidRuns("ULEB128 value is not shortest-form");
      return value;
    }
  }
  return invalidRuns("ULEB128 value exceeds ten bytes");
}

function assertAmount(amount: bigint, index: number): void {
  if (typeof amount !== "bigint" || amount <= 0n || amount > MAX_U64) {
    throw new MinatoError(
      "INVALID_PAYOUT",
      `payouts[${index}].amount must be in 1..u64::MAX`,
    );
  }
}

export function canonicalizePayouts(payouts: readonly PayoutInput[]): Payout[] {
  if (payouts.length === 0) {
    throw new MinatoError("INVALID_PAYOUT", "At least one payout is required");
  }
  const normalized = payouts.map((payout, index) => {
    assertAmount(payout.amount, index);
    return {
      recipient: normalizeAddress(
        payout.recipient,
        `payouts[${index}].recipient`,
      ),
      amount: payout.amount,
    };
  });
  const recipients = new Set<string>();
  let total = 0n;
  for (const [index, payout] of normalized.entries()) {
    if (recipients.has(payout.recipient)) {
      throw new MinatoError(
        "INVALID_PAYOUT",
        `Duplicate recipient at payouts[${index}]`,
      );
    }
    recipients.add(payout.recipient);
    total += payout.amount;
    if (total > MAX_U64) {
      throw new MinatoError(
        "INVALID_PAYOUT",
        "The distribution total exceeds u64::MAX",
      );
    }
  }
  normalized.sort((left, right) => {
    if (left.amount < right.amount) return -1;
    if (left.amount > right.amount) return 1;
    return left.recipient < right.recipient
      ? -1
      : left.recipient > right.recipient
        ? 1
        : 0;
  });
  return normalized;
}

function validateCanonicalPayouts(payouts: readonly PayoutInput[]): Payout[] {
  const canonical = canonicalizePayouts(payouts);
  for (let index = 0; index < canonical.length; index += 1) {
    const input = payouts[index];
    const expected = canonical[index];
    if (
      input === undefined ||
      expected === undefined ||
      normalizeAddress(input.recipient) !== expected.recipient ||
      input.amount !== expected.amount
    ) {
      throw new MinatoError(
        "INVALID_PAYOUT",
        "encodeRuns requires payouts sorted by amount then normalized address",
      );
    }
  }
  return canonical;
}

/** Encode canonical payouts using Minato codec v1. */
export function encodeRuns(payouts: readonly PayoutInput[]): Uint8Array {
  const canonical = validateCanonicalPayouts(payouts);
  return encodeCanonicalRuns(canonical);
}

/** Internal fast path for planner slices already proven canonical. */
export function encodeCanonicalRuns(payouts: readonly Payout[]): Uint8Array {
  const groups: { amount: bigint; count: bigint }[] = [];
  for (const payout of payouts) {
    const previous = groups.at(-1);
    if (previous?.amount === payout.amount) {
      previous.count += 1n;
    } else {
      groups.push({ amount: payout.amount, count: 1n });
    }
  }

  const bytes = [...encodeUleb128(BigInt(groups.length))];
  let previousAmount = 0n;
  for (const group of groups) {
    bytes.push(...encodeUleb128(group.amount - previousAmount));
    bytes.push(...encodeUleb128(group.count));
    previousAmount = group.amount;
  }
  return Uint8Array.from(bytes);
}

/** Decode and validate canonical Minato codec v1 bytes. */
export function decodeRuns(
  recipients: readonly string[],
  runs: Uint8Array,
): Payout[] {
  if (
    !(runs instanceof Uint8Array) ||
    recipients.length === 0 ||
    runs.length === 0
  ) {
    return invalidRuns("Recipients and runs must both be non-empty");
  }
  const normalizedRecipients = recipients.map((recipient, index) =>
    normalizeAddress(recipient, `recipients[${index}]`),
  );
  if (new Set(normalizedRecipients).size !== normalizedRecipients.length) {
    return invalidRuns("Recipient addresses must be unique");
  }

  const state = { offset: 0 };
  const groupCount = readUleb128(runs, state);
  if (groupCount === 0n || groupCount > BigInt(recipients.length)) {
    return invalidRuns(
      "Group count must be positive and no greater than recipient count",
    );
  }

  const payouts: Payout[] = [];
  let amount = 0n;
  for (let groupIndex = 0n; groupIndex < groupCount; groupIndex += 1n) {
    const delta = readUleb128(runs, state);
    const count = readUleb128(runs, state);
    if (delta === 0n || count === 0n)
      return invalidRuns("Amount deltas and run counts must be positive");
    if (amount > MAX_U64 - delta)
      return invalidRuns("Decoded amount overflows u64");
    amount += delta;
    if (count > BigInt(normalizedRecipients.length - payouts.length)) {
      return invalidRuns("Run counts exceed the recipient vector");
    }
    for (let runIndex = 0n; runIndex < count; runIndex += 1n) {
      const recipient = normalizedRecipients[payouts.length];
      if (recipient === undefined)
        return invalidRuns("Run counts exceed the recipient vector");
      payouts.push({ recipient, amount });
    }
  }
  if (payouts.length !== normalizedRecipients.length)
    return invalidRuns("Run counts do not consume recipients");
  if (state.offset !== runs.length)
    return invalidRuns("Trailing run bytes are not allowed");

  const canonical = canonicalizePayouts(payouts);
  for (let index = 0; index < payouts.length; index += 1) {
    if (
      payouts[index]?.recipient !== canonical[index]?.recipient ||
      payouts[index]?.amount !== canonical[index]?.amount
    ) {
      return invalidRuns(
        "Recipients are not canonical for the decoded amounts",
      );
    }
  }
  return payouts;
}

/** Assert that bytes are the unique canonical encoding for the recipient vector. */
export function assertCanonicalRuns(
  recipients: readonly string[],
  runs: Uint8Array,
): void {
  const payouts = decodeRuns(recipients, runs);
  const encoded = encodeRuns(payouts);
  if (
    encoded.length !== runs.length ||
    encoded.some((byte, index) => byte !== runs[index])
  ) {
    invalidRuns("Run bytes are not canonical");
  }
}
