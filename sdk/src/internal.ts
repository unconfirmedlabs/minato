import {
  isValidStructTag,
  isValidSuiAddress,
  normalizeStructTag,
  normalizeSuiAddress,
} from "@mysten/sui/utils";
import { MinatoError } from "./errors.js";

const SHORT_ADDRESS = /^(?:0x)?[0-9a-fA-F]{1,64}$/;

export function normalizeAddress(value: string, label = "address"): string {
  if (typeof value !== "string" || !SHORT_ADDRESS.test(value)) {
    throw new MinatoError(
      "INVALID_ADDRESS",
      `${label} is not a valid Sui address`,
    );
  }
  const normalized = normalizeSuiAddress(value);
  if (!isValidSuiAddress(normalized)) {
    throw new MinatoError(
      "INVALID_ADDRESS",
      `${label} is not a valid Sui address`,
    );
  }
  return normalized;
}

export function normalizeCoinType(value: string): string {
  let normalized: string;
  try {
    normalized = normalizeStructTag(value);
  } catch (error) {
    throw new MinatoError(
      "INVALID_COIN_TYPE",
      "coinType is not a valid concrete struct tag",
      {
        cause: error,
      },
    );
  }
  if (!isValidStructTag(normalized) || normalized.includes("@")) {
    throw new MinatoError(
      "INVALID_COIN_TYPE",
      "coinType is not a valid concrete struct tag",
    );
  }
  return normalized;
}

export function bytesToHex(bytes: Uint8Array): string {
  return `0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export function hexToBytes(value: string, expectedLength?: number): Uint8Array {
  if (typeof value !== "string" || !/^0x(?:[0-9a-f]{2})*$/.test(value)) {
    throw new MinatoError(
      "INVALID_HEX",
      "Expected lowercase 0x-prefixed, byte-aligned hex",
    );
  }
  const bytes = new Uint8Array((value.length - 2) / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(
      value.slice(2 + index * 2, 4 + index * 2),
      16,
    );
  }
  if (expectedLength !== undefined && bytes.length !== expectedLength) {
    throw new MinatoError(
      "INVALID_HEX",
      `Expected ${expectedLength} bytes, received ${bytes.length}`,
    );
  }
  return bytes;
}

export function ulebLength(value: number): number {
  let remaining = value;
  let length = 1;
  while (remaining >= 0x80) {
    remaining = Math.floor(remaining / 0x80);
    length += 1;
  }
  return length;
}

export function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}
