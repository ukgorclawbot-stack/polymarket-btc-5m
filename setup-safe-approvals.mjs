#!/usr/bin/env node
/**
 * Set up USDC and CTF token approvals for the Gnosis Safe via Polymarket's
 * builder-relayer-client.
 *
 * The Safe wallet cannot be controlled directly from the EOA -- transactions
 * must be relayed through Polymarket's relayer API.
 *
 * Usage:
 *   node setup-safe-approvals.mjs           # Check current approval status
 *   node setup-safe-approvals.mjs approve   # Set approvals via relayer
 */
import "dotenv/config";
import { Wallet } from "@ethersproject/wallet";
import { JsonRpcProvider } from "@ethersproject/providers";
import { Contract } from "@ethersproject/contracts";
import { createWalletClient, http, encodeFunctionData, maxUint256 } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";

const POLYGON_RPC = process.env.POLYGON_RPC || "https://polygon-bor-rpc.publicnode.com";
const CHAIN_ID = 137;

// Polymarket contract addresses on Polygon
const USDC = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const CTF = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045";
const EXCHANGE = "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E";
const NEG_RISK_EXCHANGE = "0xC5d563A36AE78145C45a50134d48A1215220f80a";
const NEG_RISK_ADAPTER = "0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296";

// Safe derivation
const SAFE_FACTORY = "0xaacFeEa03eb1561C4e67d661e40682Bd20E3541b";

const ERC20_ABI_ETHERS = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
];
const ERC1155_ABI_ETHERS = [
  "function isApprovedForAll(address account, address operator) view returns (bool)",
];

// ABIs for encoding approval transactions
const ERC20_APPROVE_ABI = [{
  name: "approve",
  type: "function",
  inputs: [
    { name: "spender", type: "address" },
    { name: "amount", type: "uint256" },
  ],
  outputs: [{ name: "", type: "bool" }],
  stateMutability: "nonpayable",
}];

const ERC1155_APPROVE_ABI = [{
  name: "setApprovalForAll",
  type: "function",
  inputs: [
    { name: "operator", type: "address" },
    { name: "approved", type: "bool" },
  ],
  outputs: [],
  stateMutability: "nonpayable",
}];

function createAllApprovalTxs() {
  const txs = [];
  const spenders = [EXCHANGE, NEG_RISK_EXCHANGE, NEG_RISK_ADAPTER];

  for (const spender of spenders) {
    // USDC ERC20 approve
    txs.push({
      to: USDC,
      data: encodeFunctionData({
        abi: ERC20_APPROVE_ABI,
        functionName: "approve",
        args: [spender, maxUint256],
      }),
    });

    // CTF ERC1155 setApprovalForAll
    txs.push({
      to: CTF,
      data: encodeFunctionData({
        abi: ERC1155_APPROVE_ABI,
        functionName: "setApprovalForAll",
        args: [spender, true],
      }),
    });
  }

  return txs;
}

async function main() {
  const command = process.argv[2] || "check";
  const provider = new JsonRpcProvider(POLYGON_RPC);
  const ethersWallet = new Wallet(process.env.PRIVATE_KEY, provider);
  const eoaAddress = ethersWallet.address;
  const safeAddress = process.env.FUNDER_ADDRESS;

  if (!safeAddress) {
    console.error("ERROR: FUNDER_ADDRESS not set in .env");
    console.error("Set FUNDER_ADDRESS to your Gnosis Safe proxy address.");
    console.error("Run: node derive-safe.mjs");
    process.exit(1);
  }

  console.log("=== Safe Wallet Approval Setup ===\n");
  console.log(`EOA address:  ${eoaAddress}`);
  console.log(`Safe address: ${safeAddress}`);

  // Verify this is the correct Safe for the EOA
  const factoryAbi = ["function computeProxyAddress(address) view returns (address)"];
  const factory = new Contract(SAFE_FACTORY, factoryAbi, provider);
  const computedSafe = await factory.computeProxyAddress(eoaAddress);
  console.log(`Derived Safe: ${computedSafe}`);
  const matches = computedSafe.toLowerCase() === safeAddress.toLowerCase();
  console.log(`Matches:      ${matches}`);

  if (!matches) {
    console.error("\nERROR: FUNDER_ADDRESS does not match the Safe derived from your EOA!");
    console.error(`Expected: ${computedSafe}`);
    console.error(`Got:      ${safeAddress}`);
    process.exit(1);
  }

  // Check on-chain balances and allowances
  const usdc = new Contract(USDC, ERC20_ABI_ETHERS, provider);
  const ctf = new Contract(CTF, ERC1155_ABI_ETHERS, provider);

  const safeBal = await usdc.balanceOf(safeAddress);
  console.log(`\nSafe USDC balance: ${(Number(safeBal) / 1e6).toFixed(6)} USDC`);

  console.log("\n--- On-chain Allowances ---");
  let allApproved = true;
  for (const [name, addr] of [["Exchange", EXCHANGE], ["NegRiskExchange", NEG_RISK_EXCHANGE], ["NegRiskAdapter", NEG_RISK_ADAPTER]]) {
    const usdcAllowance = await usdc.allowance(safeAddress, addr);
    const ctfApproved = await ctf.isApprovedForAll(safeAddress, addr);
    const usdcOk = Number(usdcAllowance) > 0;
    console.log(`  ${name}: USDC=${usdcOk ? "OK" : "MISSING"} (${(Number(usdcAllowance) / 1e6).toFixed(2)}), CTF=${ctfApproved ? "OK" : "MISSING"}`);
    if (!usdcOk || !ctfApproved) allApproved = false;
  }

  if (allApproved) {
    console.log("\nAll approvals are set. You should be able to trade.");
    return;
  }

  console.log("\nApprovals are MISSING. These must be set through Polymarket's relayer.");

  if (command === "approve") {
    console.log("\n--- Setting approvals via builder-relayer-client ---");

    // Import RelayClient dynamically (it uses CommonJS)
    const { RelayClient } = await import("@polymarket/builder-relayer-client");

    // Create a viem WalletClient for the RelayClient
    const account = privateKeyToAccount(process.env.PRIVATE_KEY);
    const walletClient = createWalletClient({
      account,
      chain: polygon,
      transport: http(POLYGON_RPC),
    });

    // The RelayClient can work without Builder credentials for basic operations.
    // For production use, provide Builder API credentials.
    const relayClient = new RelayClient(
      "https://relayer-v2.polymarket.com/",
      CHAIN_ID,
      walletClient,
      undefined, // No builder config needed for now
    );

    const approvalTxs = createAllApprovalTxs();
    console.log(`Submitting ${approvalTxs.length} approval transactions...`);

    try {
      const response = await relayClient.execute(approvalTxs, "Set all token approvals for trading");
      console.log("Transaction submitted!");
      console.log("Waiting for confirmation...");
      const result = await response.wait();
      if (result) {
        console.log("Transaction confirmed!");
        console.log(`Transaction hash: ${result.transactionHash}`);
      } else {
        console.log("Transaction may have failed. Check the relayer status.");
      }
    } catch (e) {
      console.error("Relayer error:", e.message || e);
      console.log("\nIf the relayer requires Builder API credentials, you have two options:");
      console.log("1. Get Builder credentials from Polymarket and set them in .env:");
      console.log("   POLYMARKET_BUILDER_API_KEY=...");
      console.log("   POLYMARKET_BUILDER_SECRET=...");
      console.log("   POLYMARKET_BUILDER_PASSPHRASE=...");
      console.log("2. Log into polymarket.com with your MetaMask wallet and place any");
      console.log("   trade through the UI -- this will automatically set all approvals.");
    }

    // Re-check allowances
    console.log("\n--- Re-checking allowances ---");
    for (const [name, addr] of [["Exchange", EXCHANGE], ["NegRiskExchange", NEG_RISK_EXCHANGE], ["NegRiskAdapter", NEG_RISK_ADAPTER]]) {
      const usdcAllowance = await usdc.allowance(safeAddress, addr);
      const ctfApproved = await ctf.isApprovedForAll(safeAddress, addr);
      const usdcOk = Number(usdcAllowance) > 0;
      console.log(`  ${name}: USDC=${usdcOk ? "OK" : "MISSING"}, CTF=${ctfApproved ? "OK" : "MISSING"}`);
    }
  } else {
    console.log("\nRun with 'approve' to set approvals:");
    console.log("  node setup-safe-approvals.mjs approve");
    console.log("\nOr log into polymarket.com with your MetaMask wallet and place a");
    console.log("trade through the UI -- this will automatically set all approvals.");
  }
}

main().catch(console.error);
