// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.30;

/// @notice Minimal interfaces for the exact Uniswap V4 operations used by Plank.
/// @dev Currency and BalanceDelta are value types on V4; their ABI representations
///      are address and int256 respectively.
interface IERC20Minimal {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address recipient, uint256 amount) external returns (bool);
    function transferFrom(address sender, address recipient, uint256 amount) external returns (bool);
}

interface IUniswapV4PoolManager {
    struct PoolKey {
        address currency0;
        address currency1;
        uint24 fee;
        int24 tickSpacing;
        address hooks;
    }

    struct SwapParams {
        bool zeroForOne;
        int256 amountSpecified;
        uint160 sqrtPriceLimitX96;
    }

    function unlock(bytes calldata data) external returns (bytes memory result);
    function swap(PoolKey calldata key, SwapParams calldata params, bytes calldata hookData)
        external
        returns (int256 swapDelta);
    function sync(address currency) external;
    function settle() external payable returns (uint256 paid);
    function take(address currency, address to, uint256 amount) external;
}

interface IUnlockCallback {
    function unlockCallback(bytes calldata data) external returns (bytes memory result);
}

/// @notice Exact-input, single-pool Uniswap V4 swaps for Plank's private accounts.
/// @dev The input is always pulled from msg.sender and output is always returned to
///      msg.sender. This keeps a stale approval from being useful to another caller.
contract ClankerV4SwapHelper is IUnlockCallback {
    struct CallbackData {
        address recipient;
        IUniswapV4PoolManager.PoolKey key;
        bool zeroForOne;
        uint128 amountIn;
        uint128 minimumAmountOut;
        bytes hookData;
    }

    error AlreadySwapping();
    error EmptyAmount();
    error IncompleteSwap(uint256 expected, uint256 actual);
    error InvalidCurrency();
    error InvalidDelta();
    error OnlyPoolManager();
    error SlippageExceeded(uint256 minimum, uint256 actual);
    error TokenTransferFailed(address token);
    error UnexpectedCallback();

    uint160 internal constant MIN_SQRT_PRICE_LIMIT = 4_295_128_740;
    uint160 internal constant MAX_SQRT_PRICE_LIMIT =
        1_461_446_703_485_210_103_287_273_052_203_988_822_378_723_970_341;

    IUniswapV4PoolManager public immutable poolManager;
    bool private swapping;

    constructor(IUniswapV4PoolManager poolManager_) {
        if (address(poolManager_) == address(0)) revert OnlyPoolManager();
        poolManager = poolManager_;
    }

    function swapExactInputSingle(
        IUniswapV4PoolManager.PoolKey calldata key,
        bool zeroForOne,
        uint128 amountIn,
        uint128 minimumAmountOut,
        bytes calldata hookData
    ) external returns (uint256 amountOut) {
        if (swapping) revert AlreadySwapping();
        if (amountIn == 0) revert EmptyAmount();
        address input = zeroForOne ? key.currency0 : key.currency1;
        address output = zeroForOne ? key.currency1 : key.currency0;
        if (input == address(0) || output == address(0) || input == output) {
            revert InvalidCurrency();
        }

        swapping = true;
        _safeTransferFrom(input, msg.sender, address(this), amountIn);
        CallbackData memory callback = CallbackData({
            recipient: msg.sender,
            key: key,
            zeroForOne: zeroForOne,
            amountIn: amountIn,
            minimumAmountOut: minimumAmountOut,
            hookData: hookData
        });
        bytes memory result = poolManager.unlock(abi.encode(callback));
        amountOut = abi.decode(result, (uint256));
        swapping = false;

        // Exact-input V4 swaps should consume the full input. This also prevents
        // tokens from ever becoming reusable router inventory.
        uint256 remainder = IERC20Minimal(input).balanceOf(address(this));
        if (remainder != 0) _safeTransfer(input, msg.sender, remainder);
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory result) {
        if (msg.sender != address(poolManager)) revert OnlyPoolManager();
        if (!swapping) revert UnexpectedCallback();
        CallbackData memory callback = abi.decode(data, (CallbackData));

        IUniswapV4PoolManager.SwapParams memory params = IUniswapV4PoolManager.SwapParams({
            zeroForOne: callback.zeroForOne,
            amountSpecified: -int256(uint256(callback.amountIn)),
            sqrtPriceLimitX96: callback.zeroForOne ? MIN_SQRT_PRICE_LIMIT : MAX_SQRT_PRICE_LIMIT
        });
        int256 packedDelta = poolManager.swap(callback.key, params, callback.hookData);
        uint256 amountOut = _settleSwap(callback, packedDelta);
        return abi.encode(amountOut);
    }

    function _settleSwap(CallbackData memory callback, int256 packedDelta)
        private
        returns (uint256 amountOut)
    {
        (int128 amount0, int128 amount1) = _unpackDelta(packedDelta);
        int128 inputDelta = callback.zeroForOne ? amount0 : amount1;
        int128 outputDelta = callback.zeroForOne ? amount1 : amount0;
        if (inputDelta >= 0 || outputDelta <= 0) revert InvalidDelta();

        uint256 amountUsed = uint256(-int256(inputDelta));
        if (amountUsed != callback.amountIn) {
            revert IncompleteSwap(callback.amountIn, amountUsed);
        }
        amountOut = uint256(int256(outputDelta));
        if (amountOut < callback.minimumAmountOut) {
            revert SlippageExceeded(callback.minimumAmountOut, amountOut);
        }

        address input = callback.zeroForOne ? callback.key.currency0 : callback.key.currency1;
        address output = callback.zeroForOne ? callback.key.currency1 : callback.key.currency0;
        poolManager.sync(input);
        _safeTransfer(input, address(poolManager), amountUsed);
        poolManager.settle();
        poolManager.take(output, callback.recipient, amountOut);
    }

    function _unpackDelta(int256 packedDelta)
        private
        pure
        returns (int128 amount0, int128 amount1)
    {
        amount0 = int128(packedDelta >> 128);
        amount1 = int128(uint128(uint256(packedDelta)));
    }

    function _safeTransfer(address token, address recipient, uint256 amount) private {
        (bool ok, bytes memory result) =
            token.call(abi.encodeCall(IERC20Minimal.transfer, (recipient, amount)));
        if (!ok || (result.length != 0 && !abi.decode(result, (bool)))) {
            revert TokenTransferFailed(token);
        }
    }

    function _safeTransferFrom(address token, address sender, address recipient, uint256 amount)
        private
    {
        (bool ok, bytes memory result) =
            token.call(abi.encodeCall(IERC20Minimal.transferFrom, (sender, recipient, amount)));
        if (!ok || (result.length != 0 && !abi.decode(result, (bool)))) {
            revert TokenTransferFailed(token);
        }
    }
}
