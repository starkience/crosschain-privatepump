// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.30;

import { Script } from "forge-std/Script.sol";
import { PrivateLaunchpadAccountFactory } from "../src/PrivateLaunchpadAccountFactory.sol";

contract Deploy is Script {
    function run() external returns (PrivateLaunchpadAccountFactory factory) {
        uint256 deployerKey = vm.envUint("EVM_DEPLOYER_PRIVATE_KEY");
        vm.startBroadcast(deployerKey);
        factory = new PrivateLaunchpadAccountFactory();
        vm.stopBroadcast();
    }
}

