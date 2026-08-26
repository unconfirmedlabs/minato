import type { ClientWithCoreApi } from "@mysten/sui/client";
import { normalizeAddress } from "./internal.js";
import { createMinatoCall, createMinatoTx } from "./transactions.js";

export interface MinatoOptions<Name extends string = "minato"> {
  readonly packageId: string;
  readonly name?: Name;
}

export class MinatoClient {
  readonly client: ClientWithCoreApi;
  readonly packageId: string;
  readonly call: ReturnType<typeof createMinatoCall>;
  readonly tx: ReturnType<typeof createMinatoTx>;

  constructor(options: { client: ClientWithCoreApi; packageId: string }) {
    this.client = options.client;
    this.packageId = normalizeAddress(options.packageId, "packageId");
    this.call = createMinatoCall(this.packageId);
    this.tx = createMinatoTx(this.packageId);
  }
}

/** Register Minato on any Sui v2 client via `client.$extend(minato(...))`. */
export function minato<const Name extends string = "minato">(
  options: MinatoOptions<Name>,
) {
  const name = (options.name ?? "minato") as Name;
  const packageId = normalizeAddress(options.packageId, "packageId");
  return {
    name,
    register(client: ClientWithCoreApi): MinatoClient {
      return new MinatoClient({ client, packageId });
    },
  } as const;
}
