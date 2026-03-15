#!/usr/bin/env node
/**
 * Check on-chain USDC balance and allowances for both EOA and proxy wallet.
 */
import "dotenv/config";
import { Wallet } from "@ethersproject/wallet";
import { JsonRpcProvider } from "@ethersproject/providers";
import { Contract } from "@ethersproject/contracts";

const POLYGON_RPC = "https://polygon-bor-rpc.publicnode.com";
const USDC_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const EXCHANGE = "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E";
const NEG_RISK_EXCHANGE = "0xC5d563A36AE78145C45a50134d48A1215220f80a";
const NEG_RISK_ADAPTER = "0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296";
const CTF = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045";

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function decimals() view returns (uint8)",
];

const ERC1155_ABI = [
  "function isApprovedForAll(address account, address operator) view returns (bool)",
];

async function main() {
  const provider = new JsonRpcProvider(POLYGON_RPC);
  const signer = new Wallet(process.env.PRIVATE_KEY, provider);
  const eoaAddress = signer.address;
  const proxyAddress = process.env.DEPOSIT_ADDRESS || process.env.FUNDER_ADDRESS;

  console.log(`EOA: ${eoaAddress}`);
  console.log(`Proxy: ${proxyAddress}`);

  // Check POL (MATIC) balance for gas
  const eoaPol = await provider.getBalance(eoaAddress);
  console.log(`\nEOA POL balance: ${(Number(eoaPol) / 1e18).toFixed(6)} POL`);

  if (proxyAddress) {
    const proxyPol = await provider.getBalance(proxyAddress);
    console.log(`Proxy POL balance: ${(Number(proxyPol) / 1e18).toFixed(6)} POL`);
  }

  // Check USDC balances
  const usdc = new Contract(USDC_ADDRESS, ERC20_ABI, provider);
  const decimals = await usdc.decimals();

  const eoaUsdc = await usdc.balanceOf(eoaAddress);
  console.log(`\nEOA USDC balance: ${(Number(eoaUsdc) / 10 ** decimals).toFixed(6)} USDC`);

  if (proxyAddress) {
    const proxyUsdc = await usdc.balanceOf(proxyAddress);
    console.log(`Proxy USDC balance: ${(Number(proxyUsdc) / 10 ** decimals).toFixed(6)} USDC`);

    // Check USDC allowances from proxy to exchange contracts
    console.log("\n--- Proxy USDC Allowances ---");
    for (const [name, addr] of [["Exchange", EXCHANGE], ["NegRiskExchange", NEG_RISK_EXCHANGE], ["NegRiskAdapter", NEG_RISK_ADAPTER]]) {
      const allowance = await usdc.allowance(proxyAddress, addr);
      console.log(`  ${name}: ${(Number(allowance) / 10 ** decimals).toFixed(6)} USDC`);
    }

    // Check CTF (Conditional Token) approvals from proxy to exchange contracts
    const ctf = new Contract(CTF, ERC1155_ABI, provider);
    console.log("\n--- Proxy CTF (ERC1155) Approvals ---");
    for (const [name, addr] of [["Exchange", EXCHANGE], ["NegRiskExchange", NEG_RISK_EXCHANGE], ["NegRiskAdapter", NEG_RISK_ADAPTER]]) {
      const approved = await ctf.isApprovedForAll(proxyAddress, addr);
      console.log(`  ${name}: ${approved}`);
    }
  }

  // Also check EOA allowances
  console.log("\n--- EOA USDC Allowances ---");
  for (const [name, addr] of [["Exchange", EXCHANGE], ["NegRiskExchange", NEG_RISK_EXCHANGE], ["NegRiskAdapter", NEG_RISK_ADAPTER]]) {
    const allowance = await usdc.allowance(eoaAddress, addr);
    console.log(`  ${name}: ${(Number(allowance) / 10 ** decimals).toFixed(6)} USDC`);
  }
}

main().catch(console.error);
