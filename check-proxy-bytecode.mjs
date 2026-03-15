#!/usr/bin/env node
/**
 * Read the proxy wallet's bytecode and try to decode the implementation address.
 * Also try known Polymarket factory/wallet factory addresses.
 */
import "dotenv/config";
import { Wallet } from "@ethersproject/wallet";
import { JsonRpcProvider } from "@ethersproject/providers";
import { Contract } from "@ethersproject/contracts";

const POLYGON_RPC = "https://polygon-bor-rpc.publicnode.com";

// Possible Polymarket proxy factory addresses on Polygon
const KNOWN_FACTORIES = [
  "0xaB45c5A4B0c941a2F231C04C3f49182e1A254052",
  "0x85bD5040976452e5C1e36e8a8b0Efb03bB183aee",
  "0xEE7fB91D5b776C326a728dc70e917F82d6809638",
  "0x3c208067b6C5C33db2C92C507dBcEC14c1d59EaB",
];

async function main() {
  const provider = new JsonRpcProvider(POLYGON_RPC);
  const signer = new Wallet(process.env.PRIVATE_KEY, provider);
  const eoaAddress = signer.address;
  const proxyAddress = process.env.DEPOSIT_ADDRESS;

  // Read proxy bytecode
  const code = await provider.getCode(proxyAddress);
  console.log(`Proxy bytecode (${code.length} chars): ${code}`);

  // EIP-1167 minimal proxy pattern: 0x363d3d373d3d3d363d73<impl_addr>5af43d82803e903d91602b57fd5bf3
  if (code.startsWith("0x363d3d373d3d3d363d73")) {
    const implAddr = "0x" + code.slice(22, 62);
    console.log(`\nEIP-1167 implementation: ${implAddr}`);

    // Try to read storage from the implementation
    const implCode = await provider.getCode(implAddr);
    console.log(`Implementation bytecode length: ${implCode.length}`);

    // Try common proxy wallet functions on the implementation
    const WALLET_ABI = [
      "function getOwners() view returns (address[])",
      "function isOwner(address) view returns (bool)",
    ];
    const implContract = new Contract(implAddr, WALLET_ABI, provider);
    // Note: calling these on the proxy, not impl, since it delegates
    const proxyContract = new Contract(proxyAddress, WALLET_ABI, provider);
    try {
      const owners = await proxyContract.getOwners();
      console.log(`Proxy owners: ${JSON.stringify(owners)}`);
    } catch(e) {
      console.log(`getOwners() failed: ${e.reason || e.message}`);
    }
    try {
      const isOwner = await proxyContract.isOwner(eoaAddress);
      console.log(`EOA is owner: ${isOwner}`);
    } catch(e) {
      console.log(`isOwner() failed: ${e.reason || e.message}`);
    }
  }

  // Try known factories
  console.log("\n--- Trying known factory contracts ---");
  for (const factoryAddr of KNOWN_FACTORIES) {
    const factoryCode = await provider.getCode(factoryAddr);
    if (factoryCode === "0x") {
      console.log(`${factoryAddr}: not a contract`);
      continue;
    }
    console.log(`${factoryAddr}: is a contract (${factoryCode.length} chars)`);

    // Try different ABI patterns
    const FACTORY_ABIS = [
      ["getPolyProxyWalletAddress(address)", "function getPolyProxyWalletAddress(address) view returns (address)"],
      ["proxyWalletMap(address)", "function proxyWalletMap(address) view returns (address)"],
    ];
    for (const [name, abi] of FACTORY_ABIS) {
      try {
        const factory = new Contract(factoryAddr, [abi], provider);
        const fn = name.split("(")[0];
        const result = await factory[fn](eoaAddress);
        console.log(`  ${name} => ${result}`);
      } catch(e) {
        // skip
      }
    }
  }

  // Read a few storage slots of the proxy to find the owner
  console.log("\n--- Proxy storage slots ---");
  for (let i = 0; i < 5; i++) {
    const slot = await provider.getStorageAt(proxyAddress, i);
    if (slot !== "0x0000000000000000000000000000000000000000000000000000000000000000") {
      console.log(`Slot ${i}: ${slot}`);
    }
  }
}

main().catch(console.error);
