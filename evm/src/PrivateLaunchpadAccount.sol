// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.30;

import { IPrivateLaunchpadAccount } from "./interfaces/IPrivateLaunchpadAccount.sol";

/// @notice A non-upgradeable execution account controlled by a derived, ephemeral EOA.
/// @dev A relayer can deploy this account counterfactually and execute an owner-signed batch.
///      The host launchpad remains unchanged and sees this account as the trader/creator.
contract PrivateLaunchpadAccount is IPrivateLaunchpadAccount {
    error AlreadyExecuting();
    error CallFailed(uint256 index, bytes reason);
    error DeadlineExpired(uint256 deadline);
    error InvalidFee();
    error InvalidNonce(uint256 expected, uint256 provided);
    error InvalidOwner();
    error InvalidSignature();
    error OnlyOwner();
    error ZeroTarget(uint256 index);

    event BatchExecuted(
        bytes32 indexed callsHash,
        uint256 indexed nonce,
        address indexed relayer,
        address feeToken,
        uint256 feeAmount,
        address feeRecipient
    );

    bytes4 internal constant ERC1271_MAGIC_VALUE = 0x1626ba7e;
    bytes4 internal constant ERC1271_INVALID = 0xffffffff;
    bytes4 internal constant ERC721_RECEIVED = 0x150b7a02;
    bytes4 internal constant ERC1155_RECEIVED = 0xf23a6e61;
    bytes4 internal constant ERC1155_BATCH_RECEIVED = 0xbc197c81;

    uint256 internal constant SECP256K1_HALF_N =
        0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0;

    bytes32 public constant CALL_TYPEHASH =
        keccak256("Call(address target,uint256 value,bytes data)");
    bytes32 public constant EXECUTION_TYPEHASH = keccak256(
        "Execution(bytes32 callsHash,uint256 nonce,uint256 deadline,address feeToken,uint256 feeAmount,address feeRecipient,uint256 prefund)"
    );
    bytes32 public constant DOMAIN_TYPEHASH = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    );
    bytes32 internal constant NAME_HASH = keccak256("PrivateLaunchpadAccount");
    bytes32 internal constant VERSION_HASH = keccak256("1");

    address public immutable owner;
    uint256 public nonce;
    bool private executing;

    constructor(address owner_) {
        if (owner_ == address(0)) revert InvalidOwner();
        owner = owner_;
    }

    receive() external payable { }

    function domainSeparator() public view returns (bytes32) {
        return keccak256(
            abi.encode(DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, block.chainid, address(this))
        );
    }

    function callsHash(Call[] calldata calls) public pure returns (bytes32) {
        bytes32[] memory hashes = new bytes32[](calls.length);
        for (uint256 i; i < calls.length; ++i) {
            hashes[i] = keccak256(
                abi.encode(CALL_TYPEHASH, calls[i].target, calls[i].value, keccak256(calls[i].data))
            );
        }
        return keccak256(abi.encodePacked(hashes));
    }

    function executionDigest(
        Call[] calldata calls,
        uint256 executionNonce,
        uint256 deadline,
        address feeToken,
        uint256 feeAmount,
        address feeRecipient,
        uint256 prefund
    ) public view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                EXECUTION_TYPEHASH,
                callsHash(calls),
                executionNonce,
                deadline,
                feeToken,
                feeAmount,
                feeRecipient,
                prefund
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash));
    }

    function execute(
        Call[] calldata calls,
        uint256 executionNonce,
        uint256 deadline,
        address feeToken,
        uint256 feeAmount,
        address feeRecipient,
        bytes calldata signature
    ) external payable returns (bytes[] memory results) {
        if (executing) revert AlreadyExecuting();
        if (block.timestamp > deadline) revert DeadlineExpired(deadline);
        if (executionNonce != nonce) revert InvalidNonce(nonce, executionNonce);
        if ((feeAmount == 0) != (feeRecipient == address(0))) revert InvalidFee();

        bytes32 digest = executionDigest(
            calls, executionNonce, deadline, feeToken, feeAmount, feeRecipient, msg.value
        );
        if (_recover(digest, signature) != owner) revert InvalidSignature();

        executing = true;
        nonce = executionNonce + 1;
        results = _executeCalls(calls);
        _payFee(feeToken, feeAmount, feeRecipient);
        executing = false;

        emit BatchExecuted(
            callsHash(calls), executionNonce, msg.sender, feeToken, feeAmount, feeRecipient
        );
    }

    function executeDirect(Call[] calldata calls)
        external
        payable
        returns (bytes[] memory results)
    {
        if (msg.sender != owner) revert OnlyOwner();
        if (executing) revert AlreadyExecuting();
        executing = true;
        results = _executeCalls(calls);
        executing = false;
    }

    function isValidSignature(bytes32 hash, bytes calldata signature)
        external
        view
        returns (bytes4)
    {
        return _recover(hash, signature) == owner ? ERC1271_MAGIC_VALUE : ERC1271_INVALID;
    }

    function onERC721Received(address, address, uint256, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        return ERC721_RECEIVED;
    }

    function onERC1155Received(address, address, uint256, uint256, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        return ERC1155_RECEIVED;
    }

    function onERC1155BatchReceived(
        address,
        address,
        uint256[] calldata,
        uint256[] calldata,
        bytes calldata
    ) external pure returns (bytes4) {
        return ERC1155_BATCH_RECEIVED;
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == 0x01ffc9a7 || interfaceId == ERC1271_MAGIC_VALUE
            || interfaceId == ERC721_RECEIVED || interfaceId == 0x4e2312e0;
    }

    function _executeCalls(Call[] calldata calls) private returns (bytes[] memory results) {
        results = new bytes[](calls.length);
        for (uint256 i; i < calls.length; ++i) {
            if (calls[i].target == address(0)) revert ZeroTarget(i);
            (bool ok, bytes memory result) =
                calls[i].target.call{ value: calls[i].value }(calls[i].data);
            if (!ok) revert CallFailed(i, result);
            results[i] = result;
        }
    }

    function _payFee(address feeToken, uint256 feeAmount, address feeRecipient) private {
        if (feeAmount == 0) return;
        if (feeToken == address(0)) {
            (bool sent,) = feeRecipient.call{ value: feeAmount }("");
            if (!sent) revert InvalidFee();
            return;
        }

        (bool ok, bytes memory result) =
            feeToken.call(abi.encodeWithSelector(0xa9059cbb, feeRecipient, feeAmount));
        if (!ok || (result.length != 0 && !abi.decode(result, (bool)))) revert InvalidFee();
    }

    function _recover(bytes32 digest, bytes calldata signature)
        private
        pure
        returns (address signer)
    {
        if (signature.length != 65) return address(0);
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly ("memory-safe") {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }
        if (uint256(s) > SECP256K1_HALF_N || (v != 27 && v != 28)) return address(0);
        signer = ecrecover(digest, v, r, s);
    }
}

