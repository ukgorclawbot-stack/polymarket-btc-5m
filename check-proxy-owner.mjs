#!/usr/bin/env node
/**
 * Check who owns the proxy wallet by querying the Polymarket proxy factory
 * and also try to read the proxy storage directly.
 */
import "dotenv/config";
import { Wallet } from "@ethersproject/wallet";
import { JsonRpcProvider } from "@ethersproject/providers";
import { Contract } from "@ethersproject/contracts";

const POLYGON_RPC = "https://polygon-bor-rpc.publicnode.com";

// Known Polymarket proxy wallet factory on Polygon
const PROXY_FACTORY = "0xaB45c5A4B0c941a2F231C04C3f49182e1A254052";

const FACTORY_ABI = [
  "function getPolyProxyWalletAddress(address _addr) view returns (address)",
  "function polyProxyWallets(address) view returns (address)",
];

const PROXY_WALLET_ABI = [
  "function owner() view returns (address)",
];

async function main() {
  const provider = new JsonRpcProvider(POLYGON_RPC);
  const signer = new Wallet(process.env.PRIVATE_KEY, provider);
  const eoaAddress = signer.address;
  const depositAddress = process.env.DEPOSIT_ADDRESS;

  console.log(`EOA: ${eoaAddress}`);
  console.log(`Expected proxy: ${depositAddress}`);

  // Try to get the proxy wallet for this EOA from the factory
  const factory = new Contract(PROXY_FACTORY, FACTORY_ABI, provider);

  try {
    const derivedProxy = await factory.getPolyProxyWalletAddress(eoaAddress);
    console.log(`\nFactory-derived proxy for EOA: ${derivedProxy}`);
    console.log(`Matches deposit address: ${derivedProxy.toLowerCase() === depositAddress.toLowerCase()}`);
  } catch (e) {
    console.log(`getPolyProxyWalletAddress error: ${e.message}`);
  }

  try {
    const registeredProxy = await factory.polyProxyWallets(eoaAddress);
    console.log(`Registered proxy for EOA: ${registeredProxy}`);
  } catch (e) {
    console.log(`polyProxyWallets error: ${e.message}`);
  }

  // Try to read the proxy wallet's owner
  if (depositAddress) {
    const proxyWallet = new Contract(depositAddress, PROXY_WALLET_ABI, provider);
    try {
      const owner = await proxyWallet.owner();
      console.log(`\nProxy wallet owner: ${owner}`);
      console.log(`Owner matches EOA: ${owner.toLowerCase() === eoaAddress.toLowerCase()}`);
    } catch (e) {
      console.log(`\nProxy wallet owner() call failed: ${e.message}`);

      // Try reading storage slot 0 directly (common for minimal proxies)
      try {
        const slot0 = await provider.getStorageAt(depositAddress, 0);
        console.log(`Storage slot 0: ${slot0}`);
      } catch (e2) {
        console.log(`Storage read failed: ${e2.message}`);
      }
    }
  }
}

main().catch(console.error);
