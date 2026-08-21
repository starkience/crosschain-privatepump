export const privateLaunchpadAccountAbi = [
  {
    type: "function",
    name: "nonce",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "execute",
    stateMutability: "payable",
    inputs: [
      {
        name: "calls",
        type: "tuple[]",
        components: [
          { name: "target", type: "address" },
          { name: "value", type: "uint256" },
          { name: "data", type: "bytes" },
        ],
      },
      { name: "executionNonce", type: "uint256" },
      { name: "deadline", type: "uint256" },
      { name: "feeToken", type: "address" },
      { name: "feeAmount", type: "uint256" },
      { name: "feeRecipient", type: "address" },
      { name: "signature", type: "bytes" },
    ],
    outputs: [{ name: "results", type: "bytes[]" }],
  },
] as const;

export const privateLaunchpadAccountFactoryAbi = [
  {
    type: "function",
    name: "computeAddress",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "index", type: "uint256" },
    ],
    outputs: [{ name: "predicted", type: "address" }],
  },
  {
    type: "function",
    name: "deployAndExecute",
    stateMutability: "payable",
    inputs: [
      { name: "owner", type: "address" },
      { name: "index", type: "uint256" },
      {
        name: "calls",
        type: "tuple[]",
        components: [
          { name: "target", type: "address" },
          { name: "value", type: "uint256" },
          { name: "data", type: "bytes" },
        ],
      },
      { name: "executionNonce", type: "uint256" },
      { name: "deadline", type: "uint256" },
      { name: "feeToken", type: "address" },
      { name: "feeAmount", type: "uint256" },
      { name: "feeRecipient", type: "address" },
      { name: "signature", type: "bytes" },
    ],
    outputs: [
      { name: "account", type: "address" },
      { name: "results", type: "bytes[]" },
    ],
  },
] as const;

export const erc20Abi = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;
