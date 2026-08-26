# Minato codec v1

A chunk consists of a non-empty `vector<address>` and a non-empty `vector<u8>` named `runs`. Payouts are canonicalized by ascending amount and then ascending normalized 32-byte Sui address. Recipients must be unique, every amount is in `1..u64::MAX`, and the sum of all amounts in a distribution must fit in `u64`.

`runs` contains the following unsigned LEB128 values:

```text
group_count
(amount_delta, recipient_count) repeated group_count times
```

- `group_count`, every `amount_delta`, and every `recipient_count` are positive.
- The first delta is relative to zero. Later deltas are relative to the preceding group's amount.
- Each ULEB128 value uses its shortest representation and no value exceeds ten bytes or `u64::MAX`.
- Run counts consume the recipient vector exactly.
- Trailing bytes are invalid.
- Empty chunks are invalid.

Chunks restart the amount baseline at zero, which makes each chunk independently decodable. The Move endpoint accepts one to eight chunks. Its unused fixed-arity arguments are paired empty address/run vectors after all non-empty chunks; those empty pairs are ABI padding, not codec chunks.

Golden examples:

| Payout amounts | `runs` bytes     |
| -------------- | ---------------- |
| `[1]`          | `01 01 01`       |
| `[1, 1, 128]`  | `02 01 02 7f 01` |
| `[128]`        | `01 80 01 01`    |
