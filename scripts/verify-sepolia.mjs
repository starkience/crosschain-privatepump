const baseUrl = process.env.BASE_SEPOLIA_RPC_URL;
const starknetUrl = process.env.STARKNET_SEPOLIA_RPC_URL;
if (!baseUrl || !starknetUrl) {
  throw new Error(
    "BASE_SEPOLIA_RPC_URL and STARKNET_SEPOLIA_RPC_URL are required",
  );
}

async function rpc(url, method, params) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!response.ok) throw new Error(`${method}: HTTP ${response.status}`);
  const body = await response.json();
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

const baseContracts = {
  usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  cctpTokenMessengerV2: "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA",
  clankerV31Factory: "0x2A787b2362021cC3eEa3C24C4748a6cD5B687382",
};

const starknetContracts = {
  strk20Pool: {
    address:
      "0x0254a6b2997ef52e9f830ce1f543f6b29768295e8d17e2267d672c552cfe0d91",
    classHash:
      "0x56ab118a8a6e38efc93ad758cefe909fee421fa931ce3cf72df624d345623b2",
  },
  outboundAnonymizer: {
    address:
      "0x05b85f2ae4d47c1e661533d5832fe3e4afd4c6a9b52e54b7f873a00c9b285f4e",
    classHash:
      "0x16c16379538afa9e29ac32721e7c1588262e06c2d19fb9215e21e2a8a6c57e1",
  },
  inboundAnonymizer: {
    address:
      "0x00d2a07c657d8c70f6eeddb7c8125e39b0955a40a608f63ca8a88d3ebbf72117",
    classHash:
      "0x533023c9011dc9ffe62f590e96f4077c8a48d499da43346893e3e58e6dbcdb8",
  },
};

const baseChain = await rpc(baseUrl, "eth_chainId", []);
if (baseChain !== "0x14a34")
  throw new Error(`unexpected Base chain id ${baseChain}`);
for (const [name, address] of Object.entries(baseContracts)) {
  const code = await rpc(baseUrl, "eth_getCode", [address, "latest"]);
  if (code === "0x") throw new Error(`${name}: no Base Sepolia runtime code`);
  console.log(`${name}: ${(code.length - 2) / 2} runtime bytes`);
}

const clankerDeprecated = BigInt(
  await rpc(baseUrl, "eth_call", [
    { to: baseContracts.clankerV31Factory, data: "0x0e136b19" },
    "latest",
  ]),
);
if (clankerDeprecated !== 0n)
  throw new Error("Clanker v3.1 factory is deprecated");
const clankerMaxCreatorReward = BigInt(
  await rpc(baseUrl, "eth_call", [
    { to: baseContracts.clankerV31Factory, data: "0xfa3ebd01" },
    "latest",
  ]),
);
if (clankerMaxCreatorReward !== 80n) {
  throw new Error(
    `Clanker max creator reward drifted to ${clankerMaxCreatorReward}`,
  );
}
const clankerTokenSupply = BigInt(
  await rpc(baseUrl, "eth_call", [
    { to: baseContracts.clankerV31Factory, data: "0xb152f6cf" },
    "latest",
  ]),
);
if (clankerTokenSupply !== 100_000_000_000_000_000_000_000_000_000n) {
  throw new Error(`Clanker token supply drifted to ${clankerTokenSupply}`);
}
console.log("clankerV31Factory: active, creator reward 80, supply 1e29");

const starknetChain = await rpc(starknetUrl, "starknet_chainId", []);
if (starknetChain !== "0x534e5f5345504f4c4941") {
  throw new Error(`unexpected Starknet chain id ${starknetChain}`);
}
for (const [name, expected] of Object.entries(starknetContracts)) {
  const classHash = await rpc(starknetUrl, "starknet_getClassHashAt", [
    "latest",
    expected.address,
  ]);
  if (BigInt(classHash) !== BigInt(expected.classHash)) {
    throw new Error(`${name}: class hash drift (${classHash})`);
  }
  console.log(`${name}: ${classHash}`);
}

console.log("Sepolia dependency verification passed.");
