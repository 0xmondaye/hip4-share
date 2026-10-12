// Money-path checks for the Daimo deposit config. The calldata is the whole
// risk surface: a wrong recipient word sends a real deposit to the wrong
// HyperCore account, a wrong dex word lands it in the wrong book.
// Run: node --experimental-strip-types src/lib/daimo-core.test.mjs

import assert from "node:assert/strict"
import {
  DAIMO_API,
  daimoEnabled,
  daimoWebviewUrl,
  HYPERCORE_DEPOSIT_ADAPTER,
  HYPEREVM_CHAIN_ID,
  HYPEREVM_USDC,
  hypercoreDepositCalldata,
} from "./daimo-core.ts"

// env unset in tests: feature off
assert.equal(daimoEnabled, false)
assert.equal(DAIMO_API, "https://api.daimo.com")

// destination constants — wrong values send real money to the wrong place
assert.equal(HYPEREVM_CHAIN_ID, 999)
assert.equal(HYPEREVM_USDC, "0xb88339CB7199b77E23DB6E890353E22632Ba630f")
assert.equal(HYPERCORE_DEPOSIT_ADAPTER, "0x3Df610B9168472EfC3CD37ed5005c0e78946c308")

// calldata: byte-for-byte against viem's encodeFunctionData for
// deposit(address,uint32) with destinationDex = 0xFFFFFFFF (spot)
assert.equal(
  hypercoreDepositCalldata("0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045"),
  "0xdd1d708b000000000000000000000000d8da6bf26964af9d7eed9e03e53415d37aa96045" +
    "00000000000000000000000000000000000000000000000000000000ffffffff",
)
// selector + 2 words, always
assert.equal(hypercoreDepositCalldata("0x" + "11".repeat(20)).length, 10 + 128)
// spot, never perps: the last word must be 0xFFFFFFFF
assert.ok(hypercoreDepositCalldata("0x" + "11".repeat(20)).endsWith("ffffffff"))
// garbage recipient fails closed rather than encoding a zero address
for (const bad of ["", "0x", "not-an-address", "0x1234", "0x" + "11".repeat(21)]) {
  assert.throws(() => hypercoreDepositCalldata(bad), `should throw: ${bad}`)
}

// webview URL: both params encoded; embed (inline + height reports), dark
const u = daimoWebviewUrl("s/1", "c&s=2")
assert.ok(u.startsWith("https://daimo.com/webview?session=s%2F1&cs=c%26s%3D2"))
assert.ok(u.includes("layout=embed"))
assert.ok(u.includes("theme=dark"))

console.log("daimo-core ok")
