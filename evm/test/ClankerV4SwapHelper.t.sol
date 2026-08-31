// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.30;

import { Test } from "forge-std/Test.sol";
import {
    ClankerV4SwapHelper,
    IERC20Minimal,
    IUnlockCallback,
    IUniswapV4PoolManager
} from "../src/ClankerV4SwapHelper.sol";
import { MockERC20 } from "./mocks/MockERC20.sol";

contract MockV4PoolManager is IUniswapV4PoolManager {
    uint256 public amountOut;

    function setAmountOut(uint256 value) external {
        amountOut = value;
    }

    function unlock(bytes calldata data) external returns (bytes memory result) {
        return IUnlockCallback(msg.sender).unlockCallback(data);
    }

    function swap(PoolKey calldata, SwapParams calldata params, bytes calldata)
        external
        view
        returns (int256 swapDelta)
    {
        int128 input = int128(params.amountSpecified);
        int128 output = int128(int256(amountOut));
        int128 amount0 = params.zeroForOne ? input : output;
        int128 amount1 = params.zeroForOne ? output : input;
        return (int256(amount0) << 128) | int256(uint256(uint128(amount1)));
    }

    function sync(address) external { }

    function settle() external payable returns (uint256 paid) {
        return 0;
    }

    function take(address currency, address to, uint256 amount) external {
        IERC20Minimal(currency).transfer(to, amount);
    }
}

contract ClankerV4SwapHelperTest is Test {
    MockERC20 internal input;
    MockERC20 internal output;
    MockV4PoolManager internal manager;
    ClankerV4SwapHelper internal helper;
    address internal user = address(0xBEEF);

    function setUp() external {
        input = new MockERC20("USD Coin", "USDC", 6);
        output = new MockERC20("Clanker", "CLANK", 18);
        manager = new MockV4PoolManager();
        helper = new ClankerV4SwapHelper(manager);
        input.mint(user, 25e6);
        output.mint(address(manager), 1_000_000e18);
        manager.setAmountOut(500_000e18);
        vm.prank(user);
        input.approve(address(helper), 25e6);
    }

    function testSwapsExactInputAndReturnsOutputToCaller() external {
        vm.prank(user);
        uint256 amountOut = helper.swapExactInputSingle(_poolKey(), true, 25e6, 490_000e18, "");

        assertEq(amountOut, 500_000e18);
        assertEq(input.balanceOf(user), 0);
        assertEq(input.balanceOf(address(manager)), 25e6);
        assertEq(output.balanceOf(user), 500_000e18);
        assertEq(input.balanceOf(address(helper)), 0);
        assertEq(output.balanceOf(address(helper)), 0);
    }

    function testRevertsAtomicallyWhenMinimumIsNotMet() external {
        vm.prank(user);
        vm.expectRevert(
            abi.encodeWithSelector(
                ClankerV4SwapHelper.SlippageExceeded.selector, 500_001e18, 500_000e18
            )
        );
        helper.swapExactInputSingle(_poolKey(), true, 25e6, 500_001e18, "");

        assertEq(input.balanceOf(user), 25e6);
        assertEq(input.balanceOf(address(manager)), 0);
    }

    function testApprovalCannotSpendAnotherUsersFunds() external {
        address attacker = address(0xBAD);
        vm.prank(attacker);
        vm.expectRevert();
        helper.swapExactInputSingle(_poolKey(), true, 25e6, 0, "");
        assertEq(input.balanceOf(user), 25e6);
    }

    function testSwapsInTheReverseDirection() external {
        output.mint(user, 500_000e18);
        input.mint(address(manager), 25e6);
        manager.setAmountOut(25e6);
        vm.prank(user);
        output.approve(address(helper), 500_000e18);

        vm.prank(user);
        uint256 amountOut = helper.swapExactInputSingle(_poolKey(), false, 500_000e18, 24e6, "");

        assertEq(amountOut, 25e6);
        assertEq(output.balanceOf(user), 0);
        assertEq(input.balanceOf(user), 50e6);
    }

    function _poolKey() private view returns (IUniswapV4PoolManager.PoolKey memory) {
        return IUniswapV4PoolManager.PoolKey({
            currency0: address(input),
            currency1: address(output),
            fee: 8_388_608,
            tickSpacing: 200,
            hooks: address(0x11)
        });
    }
}
