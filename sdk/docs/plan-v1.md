# Minato plan v1

Plans are immutable, JSON-safe records. Amounts use decimal strings and run bytes/hashes use lowercase, `0x`-prefixed hex. Batch ranges use a zero-based inclusive `startIndex` and exclusive `endIndex` over the canonical payout list.

## Hashes

Each hash is:

```text
SHA-256(ASCII(domain) || 0x00 || BCS(payload))
```

The domains are `minato/distribution/v1`, `minato/batch/v1`, and `minato/plan/v1`.

- Distribution payload: package ID, source address, normalized coin type string, and canonical `(address, u64)` payouts. It is independent of chunking and batching.
- Batch payload: distribution hash, package ID, source address, normalized coin type string, `u32` batch index, `u64` start index, `u64` withdrawal total, and the exact ordered non-empty chunks (address vectors and run byte vectors). The transaction context is repeated here so a standalone batch can be verified without treating the distribution hash as an unverifiable pointer.
- Plan payload: distribution hash, the complete offline limit snapshot, and ordered batch hashes.

These hashes identify distribution intent. They are not Sui transaction digests; gas choices are deliberately outside the batch hash.
They detect accidental or uncommitted changes but are not signatures and do not prove who created a plan.

## Exact offline sizing

The planner greedily chooses the largest next payout range using binary search. It derives chunk capacity from the actual BCS sizes of `vector<address>` and `vector<u8>`, uses at most eight chunks, builds the exact fixed-eight `TransactionData` with deterministic fixed-width placeholder gas references, and checks the signed envelope.

Callers must provide:

- maximum signed transaction bytes;
- maximum pure argument bytes;
- gas payment object count; and
- either every full serialized generic-signature length or a conservative fixed envelope overhead.

With signature lengths, the SDK accounts for the `SenderSignedData` vector, three intent enum tags, the signature vector, and every signature byte-vector prefix exactly. A fixed overhead is an explicit caller assertion and should include every byte outside `TransactionData`. Verification reconstructs the transactions and repeats all size checks.

Changing the gas payment count or serialized signature sizes after planning invalidates the size guarantee. Gas object IDs, versions, digests, price, and budget themselves are fixed-width in BCS and do not change the computed length.

A gas payment count of zero selects the address-balance gas size model, including the fixed-width `ValidDuring` expiration added during transaction resolution.
