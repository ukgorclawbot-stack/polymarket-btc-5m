#!/usr/bin/env node
/**
 * Derive the Polymarket Gnosis Safe proxy address for an EOA.
 *
 * Two methods:
 *   1. On-chain: Call computeProxyAddress() on the SafeProxyFactory contract
 *   2. Off-chain: Manual CREATE2 computation
 *
 * Usage:
 *   node derive-safe.mjs                    # Use EOA from .env PRIVATE_KEY
 *   node derive-safe.mjs 0xYourEOAAddress   # Derive for any EOA
 */
import "dotenv/config";
import { Wallet } from "@ethersproject/wallet";
import { JsonRpcProvider } from "@ethersproject/providers";
import { Contract } from "@ethersproject/contracts";
import { keccak256 } from "@ethersproject/keccak256";
import { defaultAbiCoder } from "@ethersproject/abi";
import { getCreate2Address } from "@ethersproject/address";

// Polymarket Safe Proxy Factory on Polygon
const SAFE_FACTORY = "0xaacFeEa03eb1561C4e67d661e40682Bd20E3541b";

// Init code hash for the GnosisSafeProxy deployed by Polymarket's factory.
// This is keccak256(abi.encodePacked(type(GnosisSafeProxy).creationCode, abi.encode(masterCopy)))
// Source: verified in polymarket-sdk Rust crate and confirmed on-chain.
const SAFE_INIT_CODE_HASH = "0x2bce2127ff07fb632d16c8347c4ebf501f4841168bed00d9e6ef715ddb6fcecf";

// For reference: the Polymarket Proxy (non-Safe) factory uses different constants:
// PROXY_FACTORY = "0xaB45c5A4B0c941a2F231C04C3f49182e1A254052"
// PROXY_INIT_CODE_HASH = "0xd21df8dc65880a8606f09fe0ce3df9b8869287ab0b058be05aa9e8af6330a00b"
// PROXY salt = keccak256(abi.encodePacked(owner))   <-- encodePacked, not encode

/**
 * Derive Safe address off-chain using CREATE2.
 *
 * The SafeProxyFactory.sol contract does:
 *   salt = keccak256(abi.encode(user))
 *   bytecodeHash = keccak256(abi.encodePacked(proxyCreationCode(), abi.encode(masterCopy)))
 *   address = CREATE2(factory, salt, bytecodeHash)
 */
function deriveSafeAddress(eoaAddress) {
  // SafeProxyFactory.getSalt() uses abi.encode (NOT abi.encodePacked)
  const salt = keccak256(defaultAbiCoder.encode(["address"], [eoaAddress]));
  return getCreate2Address(SAFE_FACTORY, salt, SAFE_INIT_CODE_HASH);
}

const POLYGON_RPC = "https://polygon-bor-rpc.publicnode.com";

async function main() {
  let eoaAddress = process.argv[2];

  if (!eoaAddress) {
    if (!process.env.PRIVATE_KEY) {
      console.error("Usage: node derive-safe.mjs <EOA_ADDRESS>");
      console.error("   or: set PRIVATE_KEY in .env");
      process.exit(1);
    }
    eoaAddress = new Wallet(process.env.PRIVATE_KEY).address;
  }

  console.log(`EOA: ${eoaAddress}`);

  // Method 1: Off-chain CREATE2 derivation
  const offchainSafe = deriveSafeAddress(eoaAddress);
  console.log(`\nOff-chain derived Safe: ${offchainSafe}`);

  // Method 2: On-chain call to computeProxyAddress
  try {
    const provider = new JsonRpcProvider(POLYGON_RPC);
    const factoryAbi = ["function computeProxyAddress(address) view returns (address)"];
    const factory = new Contract(SAFE_FACTORY, factoryAbi, provider);
    const onchainSafe = await factory.computeProxyAddress(eoaAddress);
    console.log(`On-chain computed Safe: ${onchainSafe}`);
    console.log(`Match: ${offchainSafe.toLowerCase() === onchainSafe.toLowerCase()}`);

    // Check if deployed
    const code = await provider.getCode(offchainSafe);
    console.log(`\nSafe deployed: ${code !== "0x"}`);

    if (code !== "0x") {
      const safeAbi = [
        "function getOwners() view returns (address[])",
        "function getThreshold() view returns (uint256)",
      ];
      const safe = new Contract(offchainSafe, safeAbi, provider);
      const owners = await safe.getOwners();
      const threshold = await safe.getThreshold();
      console.log(`Owners: ${owners.join(", ")}`);
      console.log(`Threshold: ${threshold.toString()}`);
    } else {
      console.log("Safe is NOT deployed yet. Deploy it through Polymarket UI or relayer.");
    }
  } catch (e) {
    console.error(`On-chain check failed: ${e.message}`);
  }

  console.log(`\n--- For .env ---`);
  console.log(`FUNDER_ADDRESS=${offchainSafe}`);
  console.log(`SIGNATURE_TYPE=2`);
}

main().catch(console.error);
