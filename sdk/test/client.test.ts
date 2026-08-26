import { SuiGrpcClient } from "@mysten/sui/grpc";
import { describe, expect, it } from "vitest";
import { MinatoClient, minato } from "../src/index.js";

describe("client extension", () => {
  it("registers the default and custom inferred names", () => {
    const base = new SuiGrpcClient({
      network: "localnet",
      baseUrl: "http://127.0.0.1:9000",
    });
    const defaultClient = base.$extend(minato({ packageId: "0x42" }));
    const customClient = base.$extend(
      minato({ packageId: "0x42", name: "distributor" }),
    );
    expect(defaultClient.minato).toBeInstanceOf(MinatoClient);
    expect(customClient.distributor.packageId).toBe(`0x${"00".repeat(31)}42`);
  });
});
