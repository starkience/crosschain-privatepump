// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.30;

import { Script } from "forge-std/Script.sol";
import { ClankerV4SwapHelper, IUniswapV4PoolManager } from "../src/ClankerV4SwapHelper.sol";

contract DeploySwapHelper is Script {
    address internal constant BASE_SEPOLIA_V4_POOL_MANAGER =
        0x05E73354cFDd6745C338b50BcFDfA3Aa6fA03408;

    function run() external returns (ClankerV4SwapHelper helper) {
        vm.startBroadcast();
        helper = new ClankerV4SwapHelper(IUniswapV4PoolManager(BASE_SEPOLIA_V4_POOL_MANAGER));
        vm.stopBroadcast();
    }
}
