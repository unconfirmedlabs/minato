export type MinatoErrorCode =
  | "INVALID_ADDRESS"
  | "INVALID_COIN_TYPE"
  | "INVALID_HEX"
  | "INVALID_LIMITS"
  | "INVALID_PAYOUT"
  | "INVALID_PLAN"
  | "INVALID_RUNS"
  | "PACKAGE_MISMATCH"
  | "TRANSACTION_TOO_LARGE";

export class MinatoError extends Error {
  readonly code: MinatoErrorCode;

  constructor(code: MinatoErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "MinatoError";
    this.code = code;
  }
}
