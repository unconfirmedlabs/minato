import type { TransactionObjectArgument } from "@mysten/sui/transactions";

export interface PayoutInput {
  readonly recipient: string;
  readonly amount: bigint;
}

export interface Payout {
  readonly recipient: string;
  readonly amount: bigint;
}

export interface JsonPayout {
  readonly recipient: string;
  readonly amount: string;
}

export interface OfflineTransactionLimits {
  readonly maxSignedTransactionBytes: number;
  readonly maxPureArgumentBytes: number;
  /** Use zero for address-balance gas; its ValidDuring expiration is included in exact sizing. */
  readonly gasPaymentCount: number;
  readonly signatureLengths?: readonly number[];
  readonly signatureOverheadBytes?: number;
}

export type SignatureModel =
  | {
      readonly kind: "serialized-signatures";
      readonly lengths: readonly number[];
    }
  | {
      readonly kind: "fixed-overhead";
      readonly bytes: number;
    };

export interface LimitSnapshot {
  readonly maxSignedTransactionBytes: number;
  readonly maxPureArgumentBytes: number;
  readonly gasPaymentCount: number;
  readonly signatureModel: SignatureModel;
}

export interface DistributionChunk {
  readonly recipients: readonly string[];
  readonly runs: string;
  readonly recipientCount: number;
  readonly totalAmount: string;
}

export interface DistributionBatch {
  readonly index: number;
  readonly startIndex: number;
  readonly endIndex: number;
  readonly packageId: string;
  readonly source: string;
  readonly coinType: string;
  readonly distributionHash: string;
  readonly recipientCount: number;
  readonly totalAmount: string;
  readonly transactionDataBytes: number;
  readonly signedTransactionBytes: number;
  readonly batchHash: string;
  readonly chunks: readonly DistributionChunk[];
}

export interface DistributionPlan {
  readonly version: 1;
  readonly packageId: string;
  readonly source: string;
  readonly coinType: string;
  readonly recipientCount: number;
  readonly totalAmount: string;
  readonly distributionHash: string;
  readonly planHash: string;
  readonly limits: LimitSnapshot;
  readonly batches: readonly DistributionBatch[];
}

export interface CreateDistributionPlanOptions {
  readonly packageId: string;
  readonly source: string;
  readonly coinType: string;
  readonly payouts: readonly PayoutInput[];
  readonly limits: OfflineTransactionLimits;
}

export interface DisperseCallOptions {
  readonly coinType: string;
  readonly balance: TransactionObjectArgument;
  readonly chunk: DistributionChunk;
}

export interface DisperseWithdrawalCallOptions {
  readonly coinType: string;
  readonly withdrawal: TransactionObjectArgument;
  readonly chunks: readonly DistributionChunk[];
}

export interface DisperseWithdrawalTransactionOptions {
  readonly batch: DistributionBatch;
}
