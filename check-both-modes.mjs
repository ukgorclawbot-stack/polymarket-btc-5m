#!/usr/bin/env node
/**
 * Check CLOB balance with both signature types to find where the funds are.
 */
import "dotenv/config";
import { ClobClient } from "@polymarket/clob-client";
import { Wallet } from "@ethersproject/wallet";

const CLOB_HOST = "https://clob.polymarket.com";
const CHAIN_ID = 137;

async function checkBalance(sigType, funder) {
  const signer = new Wallet(process.env.PRIVATE_KEY);
  const label = sigType === 0 ? "EOA" : "POLY_PROXY";

  const tempClient = new ClobClient(CLOB_HOST, CHAIN_ID, signer);
  const creds = await tempClient.createOrDeriveApiKey();

  const client = new ClobClient(
    CLOB_HOST, CHAIN_ID, signer, creds,
    sigType,
    funder || undefined,
  );

  try {
    const ba = await client.getBalanceAllowance({ asset_type: "COLLATERAL" });
    console.log(`\n[${label}] CLOB Balance: ${ba.balance} (${(Number(ba.balance) / 1e6).toFixed(6)} USDC)`);
    console.log(`[${label}] Allowances:`, JSON.stringify(ba.allowances));
  } catch (e) {
    console.log(`[${label}] Error: ${e.message}`);
  }
}

async function main() {
  const proxyAddr = process.env.DEPOSIT_ADDRESS || process.env.FUNDER_ADDRESS;
  console.log("Checking CLOB balance in both modes...");

  // Mode 1: EOA (no funder)
  await checkBalance(0, undefined);

  // Mode 2: POLY_PROXY with funder
  await checkBalance(1, proxyAddr);
}

main().catch(console.error);
