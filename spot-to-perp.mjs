// One-off: move builder USDC spot -> perps so builder-fee approval passes.
// Usage: BUILDER_PK=0x... node spot-to-perp.mjs
import * as hl from "@nktkas/hyperliquid";
import { privateKeyToAccount } from "viem/accounts";

const pk = process.env.BUILDER_PK;
if (!pk) throw new Error("set BUILDER_PK env var");

const wallet = privateKeyToAccount(pk);
console.log("builder:", wallet.address);

const client = new hl.ExchangeClient({ wallet, transport: new hl.HttpTransport() });
const res = await client.usdClassTransfer({ amount: "110", toPerp: true });
console.log(JSON.stringify(res));
