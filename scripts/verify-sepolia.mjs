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
  usdc: {
    address:
      "0x0512feac6339ff7889822cb5aa2a86c848e9d392bb0e3e237c008674feed8343",
    classHash:
      "0x78a357382d29a07ab7e32c5ce3ffae20021abee67c353b8885737b1d643eac9",
  },
  cctpTokenMessengerV2: {
    address:
      "0x04bdde1e09a4b09a2f95d893d94a967b7717eb85a3f6deca8c080ee01fbc3370",
    classHash:
      "0x3de0c68dad6bab78275624542e25ffab0d4a80f5bfdfc19765d177746cb3c35",
  },
  cctpMessageTransmitterV2: {
    address:
      "0x04db7926c64f1f32a840f3fa95cb551f3801a3600bae87af87807a54dce12fe8",
    classHash:
      "0x1a82c735c08fb38dbc5b7b6e5f57973ad3a8fcf224a5f082fb9a7c8388f7ba1",
  },
};

const ozAccountClassHash =
  "0x5b4b537eaa2399e3aa99c4e2e0208ebd6c71bc1467938cd52c798c601e43564";
const requiredAccountEntrypoints = [
  "constructor",
  "__execute__",
  "__validate__",
  "__validate_deploy__",
  "execute_from_outside_v2",
  "is_valid_signature",
];

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

const accountClass = await rpc(starknetUrl, "starknet_getClass", {
  block_id: "latest",
  class_hash: ozAccountClassHash,
});
if (accountClass.contract_class_version !== "0.1.0") {
  throw new Error(
    `OZ account class version drifted to ${accountClass.contract_class_version}`,
  );
}
const accountAbi =
  typeof accountClass.abi === "string"
    ? JSON.parse(accountClass.abi)
    : accountClass.abi;
const accountEntrypoints = new Set(
  accountAbi.flatMap((item) => [
    ...(typeof item.name === "string" ? [item.name] : []),
    ...(Array.isArray(item.items)
      ? item.items
          .map((entry) => entry.name)
          .filter((name) => typeof name === "string")
      : []),
  ]),
);
for (const name of requiredAccountEntrypoints) {
  if (!accountEntrypoints.has(name)) {
    throw new Error(`OZ account class is missing ${name}`);
  }
}
console.log(
  `ozAccountClass: ${ozAccountClassHash}, version 0.1.0, required ABI present`,
);

console.log("Sepolia dependency verification passed.");
