import { defineChain, getAddress, type Address } from "viem";

export const ROBINHOOD_MAINNET_CHAIN_ID = 4663 as const;
export const ROBINHOOD_TESTNET_CHAIN_ID = 46630 as const;

export const robinhood = defineChain({
  id: ROBINHOOD_MAINNET_CHAIN_ID,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://rpc.mainnet.chain.robinhood.com"] },
  },
  blockExplorers: {
    default: {
      name: "Robinhood Chain Explorer",
      url: "https://robinhoodchain.blockscout.com",
    },
  },
});

export const robinhoodTestnet = defineChain({
  id: ROBINHOOD_TESTNET_CHAIN_ID,
  name: "Robinhood Chain Testnet",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://rpc.testnet.chain.robinhood.com"] },
  },
  blockExplorers: {
    default: {
      name: "Robinhood Chain Testnet Explorer",
      url: "https://explorer.testnet.chain.robinhood.com",
    },
  },
  testnet: true,
});

export interface PonsV2Deployment {
  readonly chainId: typeof ROBINHOOD_MAINNET_CHAIN_ID;
  readonly factory: Address;
  readonly memeHook: Address;
  readonly feeEscrow: Address;
  readonly buybackVault: Address;
  readonly launchLocker: Address;
  readonly launchAndBuy: Address;
  readonly launchDeployer: Address;
  readonly graduationExecutor: Address;
  readonly graduationGuard: Address;
  readonly usdg: Address;
  readonly sourceCommit: string;
  readonly researchedAt: string;
}

/**
 * Current Pons V2 stack read from the official docs and checked onchain on
 * 2026-08-26. Pons stacks are replaced as a unit, so callers must still map an
 * older token to the factory stack that launched it.
 */
export const PONS_V2_ROBINHOOD: PonsV2Deployment = {
  chainId: ROBINHOOD_MAINNET_CHAIN_ID,
  factory: getAddress("0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e"),
  memeHook: getAddress("0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044"),
  feeEscrow: getAddress("0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e"),
  buybackVault: getAddress("0x42df2a798f82289E177311362e8f5ccC45c1219c"),
  launchLocker: getAddress("0x267444D099b10fB5Ed7c3Cc7B7c767AdcA574952"),
  launchAndBuy: getAddress("0xe33E9E479dF8802cb0866d5d05258bEc4cF62948"),
  launchDeployer: getAddress("0x3711ceA4feaDE896C913C68F01Eda97Cb06D1A42"),
  graduationExecutor: getAddress("0xC7819B64A1dAECD7eC19856d026cb14EfBd89046"),
  graduationGuard: getAddress("0xf5695117b99B6f6401e67d4195BD653628176C6C"),
  usdg: getAddress("0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168"),
  sourceCommit: "b59402035f98a912042734142ea885595f0b4e95",
  researchedAt: "2026-08-26",
};

/** No official Pons V2 testnet deployment was published at the research snapshot. */
export const PONS_V2_ROBINHOOD_TESTNET: PonsV2Deployment | undefined =
  undefined;
