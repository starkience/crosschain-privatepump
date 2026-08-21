// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.30;

import { Test } from "forge-std/Test.sol";
import { PrivateLaunchpadAccount } from "../src/PrivateLaunchpadAccount.sol";
import { PrivateLaunchpadAccountFactory } from "../src/PrivateLaunchpadAccountFactory.sol";
import { IPrivateLaunchpadAccount } from "../src/interfaces/IPrivateLaunchpadAccount.sol";
import { MockERC20 } from "./mocks/MockERC20.sol";
import { MockLaunchpad } from "./mocks/MockLaunchpad.sol";

contract PrivateLaunchpadAccountTest is Test {
    uint256 internal constant OWNER_KEY = 0xA11CE;
    uint256 internal constant OTHER_KEY = 0xB0B;

    PrivateLaunchpadAccountFactory internal factory;
    PrivateLaunchpadAccount internal account;
    MockERC20 internal usdc;
    MockERC20 internal meme;
    MockLaunchpad internal launchpad;
    address internal owner;
    address internal relayer = makeAddr("relayer");

    function setUp() external {
        owner = vm.addr(OWNER_KEY);
        factory = new PrivateLaunchpadAccountFactory();
        account = factory.deploy(owner, 0);
        usdc = new MockERC20("USD Coin", "USDC", 6);
        meme = new MockERC20("Meme", "MEME", 18);
        launchpad = new MockLaunchpad(usdc, meme);
        usdc.mint(address(account), 100e6);
        usdc.mint(address(launchpad), 1_000e6);
    }

    function testCounterfactualAddressCanReceiveBeforeDeployment() external {
        address predicted = factory.computeAddress(owner, 7);
        usdc.mint(predicted, 25e6);
        assertEq(predicted.code.length, 0);

        PrivateLaunchpadAccount deployed = factory.deploy(owner, 7);
        assertEq(address(deployed), predicted);
        assertEq(usdc.balanceOf(predicted), 25e6);
        assertEq(deployed.owner(), owner);
    }

    function testCounterfactualAccountDeploysAndExecutesAtomically() external {
        uint256 accountIndex = 9;
        address predicted = factory.computeAddress(owner, accountIndex);
        usdc.mint(predicted, 25e6);

        IPrivateLaunchpadAccount.Call[] memory calls = new IPrivateLaunchpadAccount.Call[](1);
        calls[0] = IPrivateLaunchpadAccount.Call({
            target: address(usdc), value: 0, data: abi.encodeCall(MockERC20.transfer, (owner, 3e6))
        });
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory signature = _signature(
            OWNER_KEY, _executionDigest(predicted, calls, 0, deadline, address(0), 0, address(0), 0)
        );

        vm.prank(relayer);
        (address deployed,) = factory.deployAndExecute(
            owner, accountIndex, calls, 0, deadline, address(0), 0, address(0), signature
        );

        assertEq(deployed, predicted);
        assertGt(deployed.code.length, 0);
        assertEq(PrivateLaunchpadAccount(payable(deployed)).nonce(), 1);
        assertEq(usdc.balanceOf(owner), 3e6);
        assertEq(usdc.balanceOf(deployed), 22e6);
    }

    function testCallsHashMatchesTypescriptSdkVector() external view {
        IPrivateLaunchpadAccount.Call[] memory calls = new IPrivateLaunchpadAccount.Call[](1);
        calls[0] = IPrivateLaunchpadAccount.Call({
            target: 0x3333333333333333333333333333333333333333, value: 7, data: hex"123456"
        });
        assertEq(
            account.callsHash(calls),
            0x71bd0ec9d81fa19637813f9fa68d341b8f2ef0dc2b7eb33a1a3065de7ae04046
        );
    }

    function testRelayedBuyAndSellAgainstUnchangedLaunchpad() external {
        IPrivateLaunchpadAccount.Call[] memory buyCalls = new IPrivateLaunchpadAccount.Call[](2);
        buyCalls[0] = IPrivateLaunchpadAccount.Call({
            target: address(usdc),
            value: 0,
            data: abi.encodeCall(MockERC20.approve, (address(launchpad), 10e6))
        });
        buyCalls[1] = IPrivateLaunchpadAccount.Call({
            target: address(launchpad),
            value: 0,
            data: abi.encodeCall(MockLaunchpad.buy, (10e6, 1_000e6))
        });

        uint256 deadline = block.timestamp + 1 hours;
        bytes memory buySignature = _sign(buyCalls, 0, deadline, address(0), 0, address(0), 0);
        vm.prank(relayer);
        account.execute(buyCalls, 0, deadline, address(0), 0, address(0), buySignature);

        assertEq(usdc.balanceOf(address(account)), 90e6);
        assertEq(meme.balanceOf(address(account)), 1_000e6);

        IPrivateLaunchpadAccount.Call[] memory sellCalls = new IPrivateLaunchpadAccount.Call[](2);
        sellCalls[0] = IPrivateLaunchpadAccount.Call({
            target: address(meme),
            value: 0,
            data: abi.encodeCall(MockERC20.approve, (address(launchpad), 1_000e6))
        });
        sellCalls[1] = IPrivateLaunchpadAccount.Call({
            target: address(launchpad),
            value: 0,
            data: abi.encodeCall(MockLaunchpad.sell, (1_000e6, 10e6))
        });

        bytes memory sellSignature = _sign(sellCalls, 1, deadline, address(0), 0, address(0), 0);
        vm.prank(relayer);
        account.execute(sellCalls, 1, deadline, address(0), 0, address(0), sellSignature);

        assertEq(account.nonce(), 2);
        assertEq(usdc.balanceOf(address(account)), 100e6);
        assertEq(meme.balanceOf(address(account)), 0);
    }

    function testRelayerFeeCanBePaidInUsdc() external {
        IPrivateLaunchpadAccount.Call[] memory calls = new IPrivateLaunchpadAccount.Call[](0);
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory signature = _sign(calls, 0, deadline, address(usdc), 1e6, relayer, 0);

        vm.prank(relayer);
        account.execute(calls, 0, deadline, address(usdc), 1e6, relayer, signature);

        assertEq(usdc.balanceOf(relayer), 1e6);
        assertEq(usdc.balanceOf(address(account)), 99e6);
    }

    function testRejectsWrongSignerAndReplay() external {
        IPrivateLaunchpadAccount.Call[] memory calls = new IPrivateLaunchpadAccount.Call[](0);
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 digest = account.executionDigest(calls, 0, deadline, address(0), 0, address(0), 0);
        bytes memory wrongSignature = _signature(OTHER_KEY, digest);

        vm.expectRevert(PrivateLaunchpadAccount.InvalidSignature.selector);
        account.execute(calls, 0, deadline, address(0), 0, address(0), wrongSignature);

        bytes memory signature = _signature(OWNER_KEY, digest);
        account.execute(calls, 0, deadline, address(0), 0, address(0), signature);

        vm.expectRevert(abi.encodeWithSelector(PrivateLaunchpadAccount.InvalidNonce.selector, 1, 0));
        account.execute(calls, 0, deadline, address(0), 0, address(0), signature);
    }

    function testRejectsExpiredExecution() external {
        IPrivateLaunchpadAccount.Call[] memory calls = new IPrivateLaunchpadAccount.Call[](0);
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory signature = _sign(calls, 0, deadline, address(0), 0, address(0), 0);
        vm.warp(deadline + 1);

        vm.expectRevert(
            abi.encodeWithSelector(PrivateLaunchpadAccount.DeadlineExpired.selector, deadline)
        );
        account.execute(calls, 0, deadline, address(0), 0, address(0), signature);
        assertEq(account.nonce(), 0);
    }

    function testRevertedBatchIsAtomicAndDoesNotConsumeNonce() external {
        IPrivateLaunchpadAccount.Call[] memory calls = new IPrivateLaunchpadAccount.Call[](2);
        calls[0] = IPrivateLaunchpadAccount.Call({
            target: address(usdc),
            value: 0,
            data: abi.encodeCall(MockERC20.approve, (address(launchpad), 10e6))
        });
        calls[1] = IPrivateLaunchpadAccount.Call({
            target: address(launchpad),
            value: 0,
            data: abi.encodeCall(MockLaunchpad.buy, (10e6, type(uint256).max))
        });
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory signature = _sign(calls, 0, deadline, address(0), 0, address(0), 0);

        vm.expectPartialRevert(PrivateLaunchpadAccount.CallFailed.selector);
        account.execute(calls, 0, deadline, address(0), 0, address(0), signature);

        assertEq(account.nonce(), 0);
        assertEq(usdc.allowance(address(account), address(launchpad)), 0);
        assertEq(usdc.balanceOf(address(account)), 100e6);
    }

    function testSignatureBindsPrefund() external {
        IPrivateLaunchpadAccount.Call[] memory calls = new IPrivateLaunchpadAccount.Call[](0);
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory signature = _sign(calls, 0, deadline, address(0), 0, address(0), 0);

        vm.deal(relayer, 1 ether);
        vm.prank(relayer);
        vm.expectRevert(PrivateLaunchpadAccount.InvalidSignature.selector);
        account.execute{ value: 1 wei }(calls, 0, deadline, address(0), 0, address(0), signature);
    }

    function testSignedNativePrefundCanPayRelayerAndLeaveGasBalance() external {
        IPrivateLaunchpadAccount.Call[] memory calls = new IPrivateLaunchpadAccount.Call[](0);
        uint256 deadline = block.timestamp + 1 hours;
        uint256 prefund = 0.25 ether;
        uint256 fee = 0.01 ether;
        bytes memory signature = _sign(calls, 0, deadline, address(0), fee, relayer, prefund);

        vm.deal(relayer, 1 ether);
        vm.prank(relayer);
        account.execute{ value: prefund }(calls, 0, deadline, address(0), fee, relayer, signature);

        assertEq(address(account).balance, prefund - fee);
        assertEq(relayer.balance, 1 ether - prefund + fee);
    }

    function testOwnerCanExecuteDirectly() external {
        IPrivateLaunchpadAccount.Call[] memory calls = new IPrivateLaunchpadAccount.Call[](1);
        calls[0] = IPrivateLaunchpadAccount.Call({
            target: address(usdc), value: 0, data: abi.encodeCall(MockERC20.transfer, (owner, 2e6))
        });
        vm.prank(owner);
        account.executeDirect(calls);
        assertEq(usdc.balanceOf(owner), 2e6);
    }

    function _sign(
        IPrivateLaunchpadAccount.Call[] memory calls,
        uint256 executionNonce,
        uint256 deadline,
        address feeToken,
        uint256 feeAmount,
        address feeRecipient,
        uint256 prefund
    ) internal view returns (bytes memory) {
        bytes32 digest = account.executionDigest(
            calls, executionNonce, deadline, feeToken, feeAmount, feeRecipient, prefund
        );
        return _signature(OWNER_KEY, digest);
    }

    function _executionDigest(
        address verifyingAccount,
        IPrivateLaunchpadAccount.Call[] memory calls,
        uint256 executionNonce,
        uint256 deadline,
        address feeToken,
        uint256 feeAmount,
        address feeRecipient,
        uint256 prefund
    ) internal view returns (bytes32) {
        bytes32 domainSeparator = keccak256(
            abi.encode(
                account.DOMAIN_TYPEHASH(),
                keccak256("PrivateLaunchpadAccount"),
                keccak256("1"),
                block.chainid,
                verifyingAccount
            )
        );
        bytes32 structHash = keccak256(
            abi.encode(
                account.EXECUTION_TYPEHASH(),
                account.callsHash(calls),
                executionNonce,
                deadline,
                feeToken,
                feeAmount,
                feeRecipient,
                prefund
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
    }

    function _signature(uint256 key, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }
}
