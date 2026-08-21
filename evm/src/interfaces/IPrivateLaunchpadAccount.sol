// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.30;

interface IPrivateLaunchpadAccount {
    struct Call {
        address target;
        uint256 value;
        bytes data;
    }

    function owner() external view returns (address);

    function nonce() external view returns (uint256);

    function callsHash(Call[] calldata calls) external pure returns (bytes32);

    function executionDigest(
        Call[] calldata calls,
        uint256 executionNonce,
        uint256 deadline,
        address feeToken,
        uint256 feeAmount,
        address feeRecipient,
        uint256 prefund
    ) external view returns (bytes32);

    function execute(
        Call[] calldata calls,
        uint256 executionNonce,
        uint256 deadline,
        address feeToken,
        uint256 feeAmount,
        address feeRecipient,
        bytes calldata signature
    ) external payable returns (bytes[] memory results);

    function executeDirect(Call[] calldata calls) external payable returns (bytes[] memory results);
}

