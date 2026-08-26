import { describe, expect, it } from "vitest";
import {
  MinatoError,
  assertCanonicalRuns,
  decodeRuns,
  encodeRuns,
} from "../src/index.js";

const A = `0x${"00".repeat(31)}01`;
const B = `0x${"00".repeat(31)}02`;
const C = `0x${"00".repeat(31)}03`;

describe("codec v1", () => {
  it("matches golden encodings", () => {
    expect([...encodeRuns([{ recipient: A, amount: 1n }])]).toEqual([1, 1, 1]);
    expect([
      ...encodeRuns([
        { recipient: A, amount: 1n },
        { recipient: B, amount: 1n },
        { recipient: C, amount: 128n },
      ]),
    ]).toEqual([2, 1, 2, 127, 1]);
    expect([...encodeRuns([{ recipient: A, amount: 128n }])]).toEqual([
      1, 128, 1, 1,
    ]);
  });

  it("round trips u64 maximum values", () => {
    const payouts = [{ recipient: A, amount: (1n << 64n) - 1n }];
    const runs = encodeRuns(payouts);
    expect(decodeRuns([A], runs)).toEqual(payouts);
    expect(() => assertCanonicalRuns([A], runs)).not.toThrow();
  });

  it.each([
    ["empty", [A], new Uint8Array()],
    ["zero group count", [A], Uint8Array.of(0)],
    ["zero delta", [A], Uint8Array.of(1, 0, 1)],
    ["zero count", [A], Uint8Array.of(1, 1, 0)],
    ["non-shortest", [A], Uint8Array.of(1, 0x81, 0, 1)],
    ["truncated", [A], Uint8Array.of(1, 1)],
    ["trailing", [A], Uint8Array.of(1, 1, 1, 0)],
    ["count mismatch", [A, B], Uint8Array.of(1, 1, 1)],
    [
      "overflow",
      [A],
      Uint8Array.of(
        1,
        0xff,
        0xff,
        0xff,
        0xff,
        0xff,
        0xff,
        0xff,
        0xff,
        0xff,
        2,
        1,
      ),
    ],
    [
      "continuation after tenth byte",
      [A],
      Uint8Array.of(
        1,
        0x81,
        0x80,
        0x80,
        0x80,
        0x80,
        0x80,
        0x80,
        0x80,
        0x80,
        0x80,
        1,
      ),
    ],
  ])("rejects %s", (_name, recipients, runs) => {
    expect(() => decodeRuns(recipients, runs)).toThrow(MinatoError);
  });

  it("rejects noncanonical payout order and duplicates", () => {
    expect(() =>
      encodeRuns([
        { recipient: B, amount: 1n },
        { recipient: A, amount: 1n },
      ]),
    ).toThrow(/sorted/);
    expect(() =>
      encodeRuns([
        { recipient: A, amount: 1n },
        { recipient: A, amount: 2n },
      ]),
    ).toThrow(/Duplicate/);
  });
});
