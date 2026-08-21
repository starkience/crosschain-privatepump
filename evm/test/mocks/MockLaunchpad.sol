// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.30;

import { MockERC20 } from "./MockERC20.sol";

/// @dev Test fixture only. Production integrations call an existing launchpad through an adapter.
contract MockLaunchpad {
    MockERC20 public immutable quote;
    MockERC20 public immutable token;

    constructor(MockERC20 quote_, MockERC20 token_) {
        quote = quote_;
        token = token_;
    }

    function buy(uint256 quoteAmount, uint256 minTokens) external returns (uint256 tokens) {
        tokens = quoteAmount * 100;
        require(tokens >= minTokens, "SLIPPAGE");
        quote.transferFrom(msg.sender, address(this), quoteAmount);
        token.mint(msg.sender, tokens);
    }

    function sell(uint256 tokenAmount, uint256 minQuote) external returns (uint256 quoteAmount) {
        quoteAmount = tokenAmount / 100;
        require(quoteAmount >= minQuote, "SLIPPAGE");
        token.transferFrom(msg.sender, address(this), tokenAmount);
        quote.transfer(msg.sender, quoteAmount);
    }
}

