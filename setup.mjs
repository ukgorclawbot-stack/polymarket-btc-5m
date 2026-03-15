#!/usr/bin/env node
/**
 * Polymarket Trading Setup Script
 *
 * Diagnoses and fixes the proxy wallet configuration:
 * 1. Checks on-chain balances (USDC, POL)
 * 2. Determines correct SIGNATURE_TYPE (EOA vs POLY_PROXY)
 * 3. Checks CLOB balance/allowance
 * 4. Calls updateBalanceAllowance to sync
 * 5. If USDC present + allowance missing, approves exchange contracts
 *
 * Usage:
 *   node setup.mjs           # Full diagnostic
 *   node setup.mjs approve   # Set USDC allowances (needs POL for gas)
 */
import "dotenv/config";
import { ClobClient } from "@polymarket/clob-client";
import { Wallet } from "@ethersproject/wallet";
import { JsonRpcProvider } from "@ethersproject/providers";
import { Contract } from "@ethersproject/contracts";

const POLYGON_RPC = "https://polygon-bor-rpc.publicnode.com";
const CLOB_HOST = "https://clob.polymarket.com";
const CHAIN_ID = 137;

// Polymarket contracts on Polygon
const USDC = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const EXCHANGE = "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E";
const NEG_RISK_EXCHANGE = "0xC5d563A36AE78145C45a50134d48A1215220f80a";
const NEG_RISK_ADAPTER = "0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296";
const CTF = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045";
const MAX_ALLOWANCE = "115792089237316195423570985008687907853269984665640564039457584007913129639935";

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function decimals() view returns (uint8)",
];

const ERC1155_ABI = [
  "function isApprovedForAll(address account, address operator) view returns (bool)",
  "function setApprovalForAll(address operator, bool approved)",
];

const PRIVATE_KEY = process.env.PRIVATE_KEY || "";
const FUNDER_ADDRESS = process.env.FUNDER_ADDRESS || "";
const SIGNATURE_TYPE = parseInt(process.env.SIGNATURE_TYPE || "0", 10);

async function main() {
  const command = process.argv[2] || "diagnose";
  const provider = new JsonRpcProvider(POLYGON_RPC);
  const signer = new Wallet(PRIVATE_KEY, provider);
  const eoaAddress = signer.address;

  console.log("=== Polymarket Trading Setup ===\n");
  console.log(`EOA address:    ${eoaAddress}`);
  console.log(`Funder address: ${FUNDER_ADDRESS || "(not set)"}`);
  console.log(`Signature type: ${SIGNATURE_TYPE} (${["EOA", "POLY_PROXY", "POLY_GNOSIS_SAFE"][SIGNATURE_TYPE]})`);

  // 1. Check on-chain balances
  console.log("\n--- On-chain Balances ---");
  const usdc = new Contract(USDC, ERC20_ABI, provider);

  const eoaPol = await provider.getBalance(eoaAddress);
  const eoaUsdc = await usdc.balanceOf(eoaAddress);
  console.log(`EOA:   ${(Number(eoaPol) / 1e18).toFixed(6)} POL, ${(Number(eoaUsdc) / 1e6).toFixed(6)} USDC`);

  let proxyUsdc = BigInt(0);
  if (FUNDER_ADDRESS) {
    const proxyPol = await provider.getBalance(FUNDER_ADDRESS);
    proxyUsdc = BigInt((await usdc.balanceOf(FUNDER_ADDRESS)).toString());
    console.log(`Proxy: ${(Number(proxyPol) / 1e18).toFixed(6)} POL, ${(Number(proxyUsdc) / 1e6).toFixed(6)} USDC`);
  }

  // Determine which wallet has funds
  const eoaHasFunds = Number(eoaUsdc) > 0;
  const proxyHasFunds = Number(proxyUsdc) > 0;
  const hasGas = Number(eoaPol) > 0;

  // 2. Check CLOB balance
  console.log("\n--- CLOB API Balance ---");
  try {
    const tempClient = new ClobClient(CLOB_HOST, CHAIN_ID, signer);
    const creds = await tempClient.createOrDeriveApiKey();

    const client = new ClobClient(
      CLOB_HOST, CHAIN_ID, signer, creds,
      SIGNATURE_TYPE,
      FUNDER_ADDRESS || undefined,
    );

    const ba = await client.getBalanceAllowance({ asset_type: "COLLATERAL" });
    console.log(`CLOB balance: ${ba.balance} (raw units)`);
    console.log(`CLOB allowances:`);
    for (const [addr, val] of Object.entries(ba.allowances)) {
      const label = addr === EXCHANGE ? "Exchange" : addr === NEG_RISK_EXCHANGE ? "NegRiskExchange" : addr === NEG_RISK_ADAPTER ? "NegRiskAdapter" : addr;
      console.log(`  ${label}: ${val}`);
    }

    // Try to update/sync
    await client.updateBalanceAllowance({ asset_type: "COLLATERAL" });
    console.log("(Balance allowance sync requested)");
  } catch (e) {
    console.log(`CLOB error: ${e.message}`);
  }

  // 3. Check on-chain allowances
  const checkAddr = FUNDER_ADDRESS || eoaAddress;
  console.log(`\n--- On-chain Allowances for ${checkAddr} ---`);
  const ctf = new Contract(CTF, ERC1155_ABI, provider);

  for (const [name, addr] of [["Exchange", EXCHANGE], ["NegRiskExchange", NEG_RISK_EXCHANGE], ["NegRiskAdapter", NEG_RISK_ADAPTER]]) {
    const usdcAllowance = await usdc.allowance(checkAddr, addr);
    const ctfApproved = await ctf.isApprovedForAll(checkAddr, addr);
    console.log(`  ${name}: USDC=${(Number(usdcAllowance) / 1e6).toFixed(2)}, CTF=${ctfApproved}`);
  }

  // 4. Report issues and recommendations
  console.log("\n--- Diagnosis ---");
  const issues = [];

  if (!eoaHasFunds && !proxyHasFunds) {
    issues.push("NO USDC found in either EOA or proxy wallet on Polygon!");
    issues.push(`  → Deposit USDC.e to EOA: ${eoaAddress}`);
    if (FUNDER_ADDRESS) {
      issues.push(`  → Or deposit through Polymarket UI to proxy: ${FUNDER_ADDRESS}`);
    }
  }

  if (!hasGas) {
    issues.push("EOA has 0 POL — cannot pay gas for approval transactions");
    issues.push(`  → Send 0.1 POL to: ${eoaAddress}`);
  }

  if (FUNDER_ADDRESS && SIGNATURE_TYPE !== 1) {
    issues.push("FUNDER_ADDRESS is set but SIGNATURE_TYPE is not 1 (POLY_PROXY)");
    issues.push("  → Set SIGNATURE_TYPE=1 in .env, OR remove FUNDER_ADDRESS");
  }

  if (issues.length === 0) {
    console.log("No issues found! Configuration looks correct.");
  } else {
    for (const issue of issues) {
      console.log(`⚠ ${issue}`);
    }
  }

  // 5. If "approve" command and we have gas, set up allowances
  if (command === "approve") {
    if (!hasGas) {
      console.log("\n❌ Cannot approve: EOA has no POL for gas.");
      console.log(`   Send some POL to ${eoaAddress} first.`);
      return;
    }

    console.log("\n--- Setting up USDC + CTF Approvals ---");
    const usdcWrite = new Contract(USDC, ERC20_ABI, signer);
    const ctfWrite = new Contract(CTF, ERC1155_ABI, signer);

    // Note: for proxy wallets, approvals need to go through the proxy contract
    // For EOA mode (no funder), approvals are from the EOA directly
    if (!FUNDER_ADDRESS || FUNDER_ADDRESS.toLowerCase() === eoaAddress.toLowerCase()) {
      // EOA mode: approve directly
      for (const [name, addr] of [["Exchange", EXCHANGE], ["NegRiskExchange", NEG_RISK_EXCHANGE], ["NegRiskAdapter", NEG_RISK_ADAPTER]]) {
        console.log(`Approving USDC for ${name}...`);
        const tx = await usdcWrite.approve(addr, MAX_ALLOWANCE);
        console.log(`  TX: ${tx.hash}`);
        await tx.wait();
        console.log(`  Confirmed!`);

        console.log(`Approving CTF for ${name}...`);
        const tx2 = await ctfWrite.setApprovalForAll(addr, true);
        console.log(`  TX: ${tx2.hash}`);
        await tx2.wait();
        console.log(`  Confirmed!`);
      }
      console.log("\n✓ All approvals set!");
    } else {
      console.log("Proxy wallet approvals need to be done through Polymarket's system.");
      console.log("The CLOB's updateBalanceAllowance should handle this.");
      console.log("If deposits are done through Polymarket UI, approvals are automatic.");
    }
  }
}

main().catch(console.error);
