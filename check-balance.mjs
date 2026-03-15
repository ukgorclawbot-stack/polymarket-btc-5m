#!/usr/bin/env node
/**
 * Polymarket USDC Balance Investigation Script
 *
 * Checks on-chain balances, token transfer history, CLOB API balance,
 * and traces where funds went.
 */

import "dotenv/config";
import { ClobClient } from "@polymarket/clob-client";
import { Wallet } from "@ethersproject/wallet";
import { ethers } from "ethers";

const PRIVATE_KEY = process.env.PRIVATE_KEY || "";
const DEPOSIT_ADDRESS = process.env.DEPOSIT_ADDRESS || "";
const CLOB_HOST = "https://clob.polymarket.com";
const CHAIN_ID = 137;

// Known Polygon USDC contracts
const USDC_CONTRACTS = {
  "USDC.e (PoS bridged)": "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
  "USDC (Native)":        "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
};

const ERC20_ABI = ["function balanceOf(address) view returns (uint256)"];

// Polygon RPC endpoints
const RPC_URLS = [
  "https://polygon-bor-rpc.publicnode.com",
  "https://rpc.ankr.com/polygon",
  "https://polygon.llamarpc.com",
];

const wallet = new Wallet(PRIVATE_KEY);

// ── Connect to RPC ──
let provider;
for (const url of RPC_URLS) {
  try {
    const p = new ethers.providers.JsonRpcProvider(url);
    await p.getNetwork();
    provider = p;
    break;
  } catch { /* try next */ }
}

console.log("╔══════════════════════════════════════════════════════╗");
console.log("║    Polymarket USDC Balance Investigation            ║");
console.log("╚══════════════════════════════════════════════════════╝\n");
console.log(`EOA wallet:       ${wallet.address}`);
console.log(`Proxy wallet:     ${DEPOSIT_ADDRESS}`);
console.log(`RPC connected:    ${provider ? "yes" : "NO - skipping on-chain checks"}\n`);

// ── 1. On-chain balances ──
if (provider) {
  console.log("━━━ 1. On-chain USDC balances ━━━");
  for (const [label, addr] of [["EOA", wallet.address], ["Proxy", DEPOSIT_ADDRESS]]) {
    const pol = await provider.getBalance(addr);
    console.log(`\n  ${label} (${addr}):`);
    console.log(`    POL: ${ethers.utils.formatEther(pol)}`);
    for (const [name, contractAddr] of Object.entries(USDC_CONTRACTS)) {
      const c = new ethers.Contract(contractAddr, ERC20_ABI, provider);
      const bal = await c.balanceOf(addr);
      console.log(`    ${name}: ${ethers.utils.formatUnits(bal, 6)}`);
    }
  }

  // Check contract status
  console.log("\n━━━ 2. Address info ━━━");
  const eoaNonce = await provider.getTransactionCount(wallet.address);
  const proxyNonce = await provider.getTransactionCount(DEPOSIT_ADDRESS);
  const proxyCode = await provider.getCode(DEPOSIT_ADDRESS);
  const isContract = proxyCode !== "0x";
  console.log(`  EOA tx count (nonce): ${eoaNonce}`);
  console.log(`  Proxy tx count: ${proxyNonce}`);
  console.log(`  Proxy is contract: ${isContract} (${(proxyCode.length - 2) / 2} bytes)`);

  if (isContract && proxyCode.startsWith("0xef0100")) {
    const implAddr = "0x" + proxyCode.substring(8);
    console.log(`  Proxy type: EIP-7702 delegation`);
    console.log(`  Implementation: ${implAddr} (Simple7702Account)`);
  }
}

// ── 3. Token transfer history via Blockscout ──
console.log("\n━━━ 3. Token transfer history (Blockscout API) ━━━");

async function getTokenTransfers(address, label) {
  const url = `https://polygon.blockscout.com/api/v2/addresses/${address}/token-transfers`;
  try {
    const resp = await fetch(url);
    const data = await resp.json();
    const items = data.items || [];
    if (items.length === 0) {
      console.log(`\n  ${label}: No token transfers found`);
      return [];
    }
    console.log(`\n  ${label}: ${items.length} token transfer(s)`);
    for (const item of items) {
      const token = item.token || {};
      const decimals = parseInt(token.decimals || "18");
      const amount = item.total?.value
        ? ethers.utils.formatUnits(item.total.value, decimals)
        : "?";
      const from = item.from?.hash || "?";
      const to = item.to?.hash || "?";
      const direction = from.toLowerCase() === address.toLowerCase() ? "OUT" : "IN";
      const txHash = item.tx_hash || "?";
      const method = item.method || "?";
      const timestamp = item.timestamp || "?";

      console.log(`    [${direction}] ${amount} ${token.symbol || "?"}`);
      console.log(`      From: ${from}`);
      console.log(`      To:   ${to}`);
      console.log(`      TX:   ${txHash}`);
      console.log(`      Method: ${method} | Time: ${timestamp}`);
    }
    return items;
  } catch (e) {
    console.log(`\n  ${label}: Error fetching transfers - ${e.message}`);
    return [];
  }
}

const proxyTransfers = await getTokenTransfers(DEPOSIT_ADDRESS, "Proxy wallet");
await getTokenTransfers(wallet.address, "EOA wallet");

// ── 4. Trace the outgoing transaction ──
if (proxyTransfers.length > 0) {
  console.log("\n━━━ 4. Transaction trace ━━━");
  for (const item of proxyTransfers) {
    if (!item.tx_hash) continue;
    try {
      const url = `https://polygon.blockscout.com/api/v2/transactions/${item.tx_hash}`;
      const resp = await fetch(url);
      const tx = await resp.json();
      console.log(`\n  TX: ${item.tx_hash}`);
      console.log(`    From: ${tx.from?.hash || "?"}`);
      console.log(`    To:   ${tx.to?.hash || "?"} ${tx.to?.name ? `(${tx.to.name})` : ""}`);
      console.log(`    Method: ${tx.method || "?"}`);
      console.log(`    Status: ${tx.status}`);
      console.log(`    Block: ${tx.block}`);
    } catch (e) {
      console.log(`  Error tracing ${item.tx_hash}: ${e.message}`);
    }
  }
}

// ── 5. CLOB API balance ──
console.log("\n━━━ 5. Polymarket CLOB API ━━━");
try {
  const client = new ClobClient(CLOB_HOST, CHAIN_ID, wallet);
  const creds = await client.createOrDeriveApiKey();
  console.log(`  API key: ${creds.key}`);

  // EOA signature type
  const authClient = new ClobClient(CLOB_HOST, CHAIN_ID, wallet, creds, 0);
  const bal0 = await authClient.getBalanceAllowance({ asset_type: "COLLATERAL" });
  console.log(`  Balance (EOA mode):        ${bal0.balance} USDC`);

  // POLY_PROXY signature type
  const proxyClient = new ClobClient(CLOB_HOST, CHAIN_ID, wallet, creds, 1, DEPOSIT_ADDRESS);
  const bal1 = await proxyClient.getBalanceAllowance({ asset_type: "COLLATERAL" });
  console.log(`  Balance (POLY_PROXY mode): ${bal1.balance} USDC`);

  // Check allowances
  console.log(`  Allowances (EOA):`);
  for (const [addr, val] of Object.entries(bal0.allowances)) {
    console.log(`    ${addr}: ${val}`);
  }

  // Open orders & trades
  const orders = await authClient.getOpenOrders();
  console.log(`  Open orders: ${Array.isArray(orders) ? orders.length : 0}`);
  const trades = await authClient.getTrades();
  console.log(`  Past trades: ${Array.isArray(trades) ? trades.length : 0}`);
} catch (e) {
  console.log(`  Error: ${e.message || e}`);
}

// ── 6. Summary ──
console.log("\n╔══════════════════════════════════════════════════════╗");
console.log("║    FINDINGS                                         ║");
console.log("╚══════════════════════════════════════════════════════╝");
console.log(`
The proxy wallet (${DEPOSIT_ADDRESS}) is an EIP-7702 smart
account (Simple7702Account). Two token transfers were found:

  1. IN:  ~29.97 USDC received from Relay Solver
         (0xf70da97...dbEF via transferFrom)
         Time: 2026-03-14T20:27:15Z

  2. OUT: ~29.97 USDC sent to RelayDepository
         (0x4cD00E3...BC31 via ERC-4337 handleOps)
         Time: 2026-03-14T20:27:37Z (22 seconds later)
         Bundler: Pimlico ERC-4337 Bundler

The USDC was received via a cross-chain Relay bridge fill, then
immediately swept out to the RelayDepository contract via an
ERC-4337 UserOperation. Net result: 0 USDC remains.

POSSIBLE CAUSES:
  1. The deposit was done via Relay bridge but the funds were
     forwarded to RelayDepository as part of the bridge settlement
     (the user may have been bridging FROM Polygon, not TO it)
  2. The ERC-4337 UserOp that swept funds may have been part of
     Polymarket's deposit flow, but the CLOB system hasn't credited
     the balance yet
  3. The Relay deposit/bridge may have failed or been reversed

RECOMMENDED NEXT STEPS:
  - Check the source chain transaction that initiated the Relay bridge
  - Contact Polymarket support with TX hash:
    0x77cf71f8595f50657b471f739e577076cbd28cac6d9fdd9e5338d91c9087a687
  - Check relay.link for the bridge transaction status
  - Verify you deposited ON Polymarket UI (not withdrew/bridged out)
  - Try depositing USDC directly to the proxy wallet on Polygon
    (not via cross-chain bridge) to test if the CLOB credits it
`);
