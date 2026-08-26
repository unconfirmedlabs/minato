export const CODEC_VERSION = 1 as const;
export const PLAN_VERSION = 1 as const;
export const MAX_U64 = (1n << 64n) - 1n;
export const MAX_CHUNKS_PER_BATCH = 8;

export const HASH_DOMAINS = {
  distribution: "minato/distribution/v1",
  batch: "minato/batch/v1",
  plan: "minato/plan/v1",
} as const;
