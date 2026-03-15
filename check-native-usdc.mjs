#!/usr/bin/env node
/**
 * Check both USDC variants on Polygon + verify proxy wallet is a contract
 */
import "dotenv/config";
import { Wallet } from "@ethersproject/wallet";
import { JsonRpcProvider } from "@ethersproject/providers";
import { Contract } from "@ethersproject/contracts";

const POLYGON_RPC = "https://polygon-bor-rpc.publicnode.com";
const USDC_BRIDGED = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"; // USDC.e (Polymarket uses this)
const USDC_NATIVE  = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359"; // Native USDC

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
];

async function main() {
  const provider = new JsonRpcProvider(POLYGON_RPC);
  const signer = new Wallet(process.env.PRIVATE_KEY, provider);
  const eoaAddress = signer.address;
  const proxyAddress = process.env.DEPOSIT_ADDRESS || process.env.FUNDER_ADDRESS;

  // Check if proxy address is a contract (proxy wallets are smart contracts)
  const proxyCode = await provider.getCode(proxyAddress);
  console.log(`Proxy ${proxyAddress} is contract: ${proxyCode !== "0x"} (code length: ${proxyCode.length})`);

  for (const [label, addr] of [["USDC.e (bridged)", USDC_BRIDGED], ["USDC (native)", USDC_NATIVE]]) {
    const token = new Contract(addr, ERC20_ABI, provider);
    const decimals = await token.decimals();

    const eoaBal = await token.balanceOf(eoaAddress);
    const proxyBal = await token.balanceOf(proxyAddress);

    console.log(`\n${label} (${addr}):`);
    console.log(`  EOA balance:   ${(Number(eoaBal) / 10 ** decimals).toFixed(6)}`);
    console.log(`  Proxy balance: ${(Number(proxyBal) / 10 ** decimals).toFixed(6)}`);
  }
}

main().catch(console.error);
