#!/usr/bin/env node
/**
 * Try to find the correct proxy wallet for this EOA using the Polymarket
 * proxy factory at 0xaB45c5A4B0c941a2F231C04C3f49182e1A254052.
 * Also queries the CLOB server API for balance info with different sig types.
 */
import "dotenv/config";
import { Wallet } from "@ethersproject/wallet";
import { JsonRpcProvider } from "@ethersproject/providers";

const POLYGON_RPC = "https://polygon-bor-rpc.publicnode.com";
const PROXY_FACTORY = "0xaB45c5A4B0c941a2F231C04C3f49182e1A254052";

async function main() {
  const provider = new JsonRpcProvider(POLYGON_RPC);
  const signer = new Wallet(process.env.PRIVATE_KEY, provider);
  const eoaAddress = signer.address;

  console.log(`EOA: ${eoaAddress}`);
  console.log(`Expected proxy: ${process.env.DEPOSIT_ADDRESS}`);

  // Read the factory bytecode and try multiple function selectors
  const factoryCode = await provider.getCode(PROXY_FACTORY);
  console.log(`\nFactory contract size: ${factoryCode.length / 2} bytes`);

  // Try calling with raw function selectors (4 bytes)
  const selectors = [
    { name: "getPolyProxyWalletAddress(address)", sig: "0x82810c9e" },
    { name: "proxyWallet(address)", sig: "0xc4552791" },
    { name: "getProxyWallet(address)", sig: "0x99d5e33c" },
    { name: "wallets(address)", sig: "0x7bb98a68" },
  ];

  // Pad the EOA address to 32 bytes
  const paddedAddr = eoaAddress.toLowerCase().replace("0x", "").padStart(64, "0");

  for (const { name, sig } of selectors) {
    try {
      const calldata = sig + paddedAddr;
      const result = await provider.call({
        to: PROXY_FACTORY,
        data: calldata,
      });
      if (result && result !== "0x" && result !== "0x0000000000000000000000000000000000000000000000000000000000000000") {
        const addr = "0x" + result.slice(26, 66);
        console.log(`${name} => ${addr}`);
      }
    } catch (e) {
      // skip
    }
  }

  // Also try common function sigs from Polymarket factory
  // Let's brute-force check the factory's function signatures
  // by looking at the first 4 bytes of known Polymarket factory functions
  const knownSelectors = [
    // From Polymarket github and verified contracts
    "0xc4552791", // getProxy(address)
    "0x1b0f7ba9", // execute(...)
    "0xf39b5b0b", // createProxy(address)
    "0x61544c91", // getProxyAddress(address)
  ];

  for (const sel of knownSelectors) {
    try {
      const calldata = sel + paddedAddr;
      const result = await provider.call({
        to: PROXY_FACTORY,
        data: calldata,
      });
      if (result && result !== "0x" && result !== "0x0000000000000000000000000000000000000000000000000000000000000000") {
        const addr = "0x" + result.slice(26, 66);
        console.log(`Selector ${sel} => ${addr}`);
      }
    } catch(e) {
      // skip
    }
  }

  // Alternative: compute CREATE2 address manually
  // Polymarket uses CREATE2 with salt = keccak256(abi.encodePacked(owner))
  const { keccak256 } = await import("@ethersproject/keccak256");
  const { solidityKeccak256 } = await import("@ethersproject/solidity");
  const { getCreate2Address } = await import("@ethersproject/address");
  const { hexlify, concat } = await import("@ethersproject/bytes");

  // The init code hash for the proxy - we need to know this
  // But we can try computing with the proxy bytecode we found
  // The proxy bytecode was: 0xef0100e6cae83bde06e4c305530e199d7217f42808555b
  // This looks like it includes an implementation address: 0xe6cae83bde06e4c305530e199d7217f42808555b
  const implAddr = "0xe6cae83bde06e4c305530e199d7217f42808555b";
  console.log(`\nPossible implementation address from proxy bytecode: ${implAddr}`);

  // Check if impl is a contract
  const implCode = await provider.getCode(implAddr);
  console.log(`Implementation is contract: ${implCode !== "0x"} (size: ${implCode.length / 2} bytes)`);
}

main().catch(console.error);
