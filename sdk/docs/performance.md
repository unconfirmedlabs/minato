# Planner performance

The planner is single-threaded. It canonicalizes payouts once, indexes amount
groups once, computes chunk limits with exact BCS-size arithmetic, and only
materializes the winning batches. Transaction sizing builds the fixed PTB
overhead once and accounts for each pure input's BCS byte-vector contribution.

Hash payloads use a fixed-schema, preallocated BCS writer. Correctness is pinned
by `golden/v1.json`, which was independently derived with a second manual BCS
encoder, cross-checked against `@mysten/sui`, and includes the complete
`TransactionData` and `SenderSignedData` bytes.

On the canonical 144,337-recipient Bluemove manifest, the original generic
implementation took 62.99 seconds to plan and 68.86 seconds to verify. The
optimized implementation's seven-run warm median was 362.06 milliseconds to
plan (348.86–374.22 ms) and 377.75 milliseconds to verify (369.17–387.53 ms)
on the same machine: approximately 174× and 182× faster, respectively. Every
batch boundary, batch hash, plan hash, and serialized size remained identical.

The built ESM package on Node 25.2.1 produced the same plan hash with a
seven-run median of 399.90 milliseconds to plan and 452.46 milliseconds to
verify. No worker threads are used in either runtime.

Run the reproducible benchmark with:

```sh
bun run benchmark:plan /path/to/address-amount.csv
```

The command performs one warmup, verifies every measured plan, and aborts if
any measured run produces a different plan identity.
