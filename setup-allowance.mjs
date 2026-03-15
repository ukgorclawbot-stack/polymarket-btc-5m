#!/usr/bin/env node
/**
 * Diagnostic & setup script for Polymarket proxy wallet allowance.
 *
 * 1. Checks balance/allowance via CLOB API
 * 2. Calls updateBalanceAllowance to sync
 * 3. Re-checks balance/allowance
 */
import "dotenv/config";
import { ClobClient } from "@polymarket/clob-client";
import { Wallet } from "@ethersproject/wallet";

const CLOB_HOST = "https://clob.polymarket.com";
const CHAIN_ID = 137;

const PRIVATE_KEY = process.env.PRIVATE_KEY || "";
const FUNDER_ADDRESS = process.env.FUNDER_ADDRESS || "";
const SIGNATURE_TYPE = parseInt(process.env.SIGNATURE_TYPE || "0", 10);

async function main() {
  if (!PRIVATE_KEY) {
    console.error("PRIVATE_KEY not set in .env");
    process.exit(1);
  }

  const signer = new Wallet(PRIVATE_KEY);
  console.log(`EOA address: ${signer.address}`);
  console.log(`Funder (proxy) address: ${FUNDER_ADDRESS || "(not set)"}`);
  console.log(`Signature type: ${SIGNATURE_TYPE} (${SIGNATURE_TYPE === 0 ? "EOA" : SIGNATURE_TYPE === 1 ? "POLY_PROXY" : "POLY_GNOSIS_SAFE"})`);

  // Create client
  const tempClient = new ClobClient(CLOB_HOST, CHAIN_ID, signer);
  const creds = await tempClient.createOrDeriveApiKey();
  console.log(`\nAPI Key: ${creds.key?.slice(0, 16)}...`);

  const client = new ClobClient(
    CLOB_HOST,
    CHAIN_ID,
    signer,
    creds,
    SIGNATURE_TYPE,
    FUNDER_ADDRESS || undefined,
  );

  // Step 1: Check current balance/allowance
  console.log("\n--- Step 1: Check balance/allowance ---");
  try {
    const ba = await client.getBalanceAllowance({ asset_type: "COLLATERAL" });
    console.log("COLLATERAL balance/allowance:", JSON.stringify(ba, null, 2));
  } catch (e) {
    console.error("getBalanceAllowance error:", e.message);
  }

  // Step 2: Call updateBalanceAllowance to sync
  console.log("\n--- Step 2: Update balance/allowance ---");
  try {
    const updateResult = await client.updateBalanceAllowance({ asset_type: "COLLATERAL" });
    console.log("Update result:", JSON.stringify(updateResult, null, 2));
  } catch (e) {
    console.error("updateBalanceAllowance error:", e.message);
  }

  // Step 3: Re-check
  console.log("\n--- Step 3: Re-check balance/allowance ---");
  try {
    const ba2 = await client.getBalanceAllowance({ asset_type: "COLLATERAL" });
    console.log("COLLATERAL balance/allowance:", JSON.stringify(ba2, null, 2));
  } catch (e) {
    console.error("getBalanceAllowance error:", e.message);
  }

  // Also check CONDITIONAL
  try {
    const ba3 = await client.getBalanceAllowance({ asset_type: "CONDITIONAL" });
    console.log("CONDITIONAL balance/allowance:", JSON.stringify(ba3, null, 2));
  } catch (e) {
    console.error("CONDITIONAL getBalanceAllowance error:", e.message);
  }
}

main().catch(console.error);
