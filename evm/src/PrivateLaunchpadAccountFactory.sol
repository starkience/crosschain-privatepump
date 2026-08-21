// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.30;

import { PrivateLaunchpadAccount } from "./PrivateLaunchpadAccount.sol";
import { IPrivateLaunchpadAccount } from "./interfaces/IPrivateLaunchpadAccount.sol";

/// @notice Deterministically deploys one private execution account per owner/index pair.
contract PrivateLaunchpadAccountFactory {
    event AccountCreated(address indexed account, address indexed owner, uint256 indexed index);

    function accountSalt(address owner, uint256 index) public pure returns (bytes32) {
        return keccak256(abi.encode("PRIVATE_LAUNCHPAD_ACCOUNT_V1", owner, index));
    }

    function computeAddress(address owner, uint256 index) public view returns (address predicted) {
        bytes32 salt = accountSalt(owner, index);
        bytes32 initCodeHash = keccak256(
            abi.encodePacked(type(PrivateLaunchpadAccount).creationCode, abi.encode(owner))
        );
        predicted = address(
            uint160(
                uint256(
                    keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, initCodeHash))
                )
            )
        );
    }

    function deploy(address owner, uint256 index) public returns (PrivateLaunchpadAccount account) {
        address predicted = computeAddress(owner, index);
        if (predicted.code.length != 0) return PrivateLaunchpadAccount(payable(predicted));

        account = new PrivateLaunchpadAccount{ salt: accountSalt(owner, index) }(owner);
        emit AccountCreated(address(account), owner, index);
    }

    function deployAndExecute(
        address owner,
        uint256 index,
        IPrivateLaunchpadAccount.Call[] calldata calls,
        uint256 executionNonce,
        uint256 deadline,
        address feeToken,
        uint256 feeAmount,
        address feeRecipient,
        bytes calldata signature
    ) external payable returns (address account, bytes[] memory results) {
        PrivateLaunchpadAccount deployed = deploy(owner, index);
        account = address(deployed);
        results = deployed.execute{ value: msg.value }(
            calls, executionNonce, deadline, feeToken, feeAmount, feeRecipient, signature
        );
    }
}

