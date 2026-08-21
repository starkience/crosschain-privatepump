// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.30;

import { Script } from "forge-std/Script.sol";
import { PrivateLaunchpadAccountFactory } from "../src/PrivateLaunchpadAccountFactory.sol";

contract Deploy is Script {
    function run() external returns (PrivateLaunchpadAccountFactory factory) {
        vm.startBroadcast();
        factory = new PrivateLaunchpadAccountFactory();
        vm.stopBroadcast();
    }
}
