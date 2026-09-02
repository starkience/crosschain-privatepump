// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.30;

import { Test } from "forge-std/Test.sol";
import { PrivateLaunchpadAccount } from "../src/PrivateLaunchpadAccount.sol";
import { PrivateLaunchpadAccountFactory } from "../src/PrivateLaunchpadAccountFactory.sol";
import { IPrivateLaunchpadAccount } from "../src/interfaces/IPrivateLaunchpadAccount.sol";

interface IERC20PonsFork {
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

interface IPonsV2CurveFork {
    function buy(uint256 quoteIn, uint256 minTokensOut, address recipient)
        external
        payable
        returns (uint256 tokensOut);
    function sell(uint256 tokensIn, uint256 minQuoteOut, address recipient)
        external
        returns (uint256 quoteOut);
    function getReserves() external view returns (uint256 quoteReserve, uint256 tokenReserve);
    function feeBps() external view returns (uint256);
    function creatorTaxBps() external view returns (uint256);
    function currentSnipeTaxBps(address recipient) external view returns (uint256);
}

interface IPonsV2FactoryFork {
    struct Socials {
        string twitter;
        string telegram;
        string discord;
        string website;
        string farcaster;
    }

    struct TokenParams {
        string name;
        string symbol;
        string logo;
        string description;
        Socials socials;
        address creatorFeeRecipient;
        uint16 creatorTaxBps;
        bool buybackEnabled;
        bytes32 expectedEconomics;
        bytes32 salt;
    }

    struct LaunchedToken {
        address token;
        address curve;
        address deployer;
        address creatorFeeRecipient;
        address pairToken;
        uint256 graduationThreshold;
        uint24 poolFee;
        int24 tickSpacing;
        uint16 creatorTaxBps;
        bool buybackEnabled;
        uint8 phase;
        uint256 sweptQuote;
        uint256 sweptTokens;
        uint256 sweptAt;
        bool exists;
    }

    function canLaunch(address launcher) external view returns (bool);
    function launchFee() external view returns (uint256);
    function approvedPairTokens(address pairToken) external view returns (bool);
    function previewLaunchEconomics(uint256 launchConfigId, address pairToken)
        external
        view
        returns (bytes32);
    function launchToken(TokenParams calldata params, uint256 launchConfigId, address pairToken)
        external
        payable
        returns (address token, address curve);
    function getLaunchedToken(address token) external view returns (LaunchedToken memory);
}

/// @dev Run with:
/// forge test --fork-url https://rpc.mainnet.chain.robinhood.com \
///   --match-contract PonsV2ForkTest -vv
///
/// Without a Robinhood fork the test returns before changing state, so the
/// repository's normal offline Foundry suite remains deterministic.
contract PonsV2ForkTest is Test {
    uint256 internal constant OWNER_KEY = 0xA11CE;
    uint256 internal constant ACCOUNT_INDEX = 23;
    uint256 internal constant USDG_BUDGET = 100e6;
    uint256 internal constant BUY_AMOUNT = 10e6;
    uint256 internal constant RELAY_DELIVERED_BUY_AMOUNT = 1_764_547;

    address internal constant PONS_FACTORY = 0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e;
    address internal constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address internal constant PONS_DONATE = 0xD4f1C2Fb5eD5Ab256d41fefeC00fd40Dce6B7c86;
    address internal constant PRIVATE_ACCOUNT_FACTORY = 0x2f04549436Aeb3693E849E6C8121CA901edF7Ce4;

    PrivateLaunchpadAccountFactory internal accountFactory;
    PrivateLaunchpadAccount internal account;
    IPonsV2FactoryFork internal pons = IPonsV2FactoryFork(PONS_FACTORY);
    address internal owner;
    address internal relayer;
    address internal predicted;
    address internal token;
    address internal curve;
    uint256 internal deadline;

    function testCounterfactualAccountLaunchesBuysAndSellsOnLivePonsV2() external {
        if (PONS_FACTORY.code.length == 0) return;

        owner = vm.addr(OWNER_KEY);
        relayer = makeAddr("pons-relayer");
        accountFactory = new PrivateLaunchpadAccountFactory();
        predicted = accountFactory.computeAddress(owner, ACCOUNT_INDEX);
        deadline = block.timestamp + 15 minutes;
        assertEq(predicted.code.length, 0, "account must begin counterfactual");

        assertTrue(pons.canLaunch(predicted), "Pons launch gate must accept derived account");
        assertTrue(pons.approvedPairTokens(USDG), "Pons must still approve USDG");

        deal(USDG, predicted, USDG_BUDGET, true);
        assertEq(IERC20PonsFork(USDG).balanceOf(predicted), USDG_BUDGET);

        _launch();
        uint256 tokensOut = _buy();
        _sell(tokensOut);
        assertEq(account.nonce(), 3);
    }

    function testCounterfactualAccountBuysPonsDonateWithRelayDeliveredAmount() external {
        if (PONS_FACTORY.code.length == 0) return;

        owner = vm.addr(OWNER_KEY);
        relayer = makeAddr("pons-relayer");
        accountFactory = PrivateLaunchpadAccountFactory(PRIVATE_ACCOUNT_FACTORY);
        predicted = accountFactory.computeAddress(owner, ACCOUNT_INDEX);
        deadline = block.timestamp + 15 minutes;

        IPonsV2FactoryFork.LaunchedToken memory launch = pons.getLaunchedToken(PONS_DONATE);
        assertTrue(launch.exists, "PonsDonate must remain registered");
        assertEq(launch.phase, 0, "PonsDonate must remain on its curve");
        curve = launch.curve;

        deal(USDG, predicted, RELAY_DELIVERED_BUY_AMOUNT, true);
        IPrivateLaunchpadAccount.Call[] memory buyCalls = new IPrivateLaunchpadAccount.Call[](2);
        buyCalls[0] = IPrivateLaunchpadAccount.Call({
            target: USDG,
            value: 0,
            data: abi.encodeCall(IERC20PonsFork.approve, (curve, RELAY_DELIVERED_BUY_AMOUNT))
        });
        IPonsV2CurveFork ponsDonateCurve = IPonsV2CurveFork(curve);
        (uint256 quoteReserve, uint256 tokenReserve) = ponsDonateCurve.getReserves();
        uint256 fee = RELAY_DELIVERED_BUY_AMOUNT * ponsDonateCurve.feeBps() / 10_000;
        uint256 tax = RELAY_DELIVERED_BUY_AMOUNT * ponsDonateCurve.creatorTaxBps() / 10_000;
        uint256 snipeTax =
            RELAY_DELIVERED_BUY_AMOUNT * ponsDonateCurve.currentSnipeTaxBps(predicted) / 10_000;
        uint256 netInput = RELAY_DELIVERED_BUY_AMOUNT - fee - tax - snipeTax;
        uint256 quotedTokensOut = netInput * tokenReserve / (quoteReserve + netInput);
        uint256 minimumTokensOut = quotedTokensOut * 9_900 / 10_000;
        buyCalls[1] = IPrivateLaunchpadAccount.Call({
            target: curve,
            value: 0,
            data: abi.encodeCall(
                IPonsV2CurveFork.buy, (RELAY_DELIVERED_BUY_AMOUNT, minimumTokensOut, predicted)
            )
        });
        bytes memory buySignature =
            _signWithName(predicted, buyCalls, 0, deadline, 0, "PonsPrivacyAccount");

        vm.prank(relayer);
        (, bytes[] memory results) = accountFactory.deployAndExecute(
            owner, ACCOUNT_INDEX, buyCalls, 0, deadline, address(0), 0, address(0), buySignature
        );

        uint256 tokensOut = abi.decode(results[1], (uint256));
        assertGt(tokensOut, 0);
        assertEq(IERC20PonsFork(PONS_DONATE).balanceOf(predicted), tokensOut);
        assertEq(IERC20PonsFork(USDG).balanceOf(predicted), 0);
    }

    function _launch() internal {
        uint256 launchFee = pons.launchFee();
        bytes32 economics = pons.previewLaunchEconomics(0, USDG);
        IPonsV2FactoryFork.TokenParams memory params = IPonsV2FactoryFork.TokenParams({
            name: "Private Account Fork Proof",
            symbol: "PAFP",
            logo: "",
            description: "Pons V2 smart-account compatibility proof",
            socials: IPonsV2FactoryFork.Socials({
                twitter: "", telegram: "", discord: "", website: "", farcaster: ""
            }),
            creatorFeeRecipient: predicted,
            creatorTaxBps: 0,
            buybackEnabled: false,
            expectedEconomics: economics,
            salt: keccak256(abi.encode("private-pons-fork", predicted, block.number))
        });

        IPrivateLaunchpadAccount.Call[] memory launchCalls = new IPrivateLaunchpadAccount.Call[](1);
        launchCalls[0] = IPrivateLaunchpadAccount.Call({
            target: PONS_FACTORY,
            value: launchFee,
            data: abi.encodeCall(IPonsV2FactoryFork.launchToken, (params, 0, USDG))
        });
        bytes memory launchSignature = _sign(predicted, launchCalls, 0, deadline, launchFee);

        vm.deal(relayer, launchFee);
        vm.prank(relayer);
        (, bytes[] memory launchResults) = accountFactory.deployAndExecute{ value: launchFee }(
            owner,
            ACCOUNT_INDEX,
            launchCalls,
            0,
            deadline,
            address(0),
            0,
            address(0),
            launchSignature
        );
        (token, curve) = abi.decode(launchResults[0], (address, address));
        account = PrivateLaunchpadAccount(payable(predicted));

        IPonsV2FactoryFork.LaunchedToken memory launch = pons.getLaunchedToken(token);
        assertTrue(launch.exists);
        assertEq(launch.token, token);
        assertEq(launch.curve, curve);
        assertEq(launch.deployer, predicted, "root wallet leaked into deployer attribution");
        assertEq(
            launch.creatorFeeRecipient, predicted, "creator fees escaped the execution account"
        );
        assertEq(launch.pairToken, USDG);
        assertEq(launch.phase, 0);
        assertEq(predicted.balance, 0, "signed launch prefund must be fully spent");
    }

    function _buy() internal returns (uint256 tokensOut) {
        IPrivateLaunchpadAccount.Call[] memory buyCalls = new IPrivateLaunchpadAccount.Call[](2);
        buyCalls[0] = IPrivateLaunchpadAccount.Call({
            target: USDG,
            value: 0,
            data: abi.encodeCall(IERC20PonsFork.approve, (curve, BUY_AMOUNT))
        });
        buyCalls[1] = IPrivateLaunchpadAccount.Call({
            target: curve,
            value: 0,
            data: abi.encodeCall(IPonsV2CurveFork.buy, (BUY_AMOUNT, 1, predicted))
        });
        bytes memory buySignature = _sign(predicted, buyCalls, 1, deadline, 0);
        vm.prank(relayer);
        bytes[] memory buyResults =
            account.execute(buyCalls, 1, deadline, address(0), 0, address(0), buySignature);
        tokensOut = abi.decode(buyResults[1], (uint256));
        assertGt(tokensOut, 0);
        assertEq(IERC20PonsFork(token).balanceOf(predicted), tokensOut);
        assertEq(IERC20PonsFork(USDG).balanceOf(predicted), USDG_BUDGET - BUY_AMOUNT);
    }

    function _sell(uint256 tokensOut) internal {
        IPrivateLaunchpadAccount.Call[] memory sellCalls = new IPrivateLaunchpadAccount.Call[](2);
        sellCalls[0] = IPrivateLaunchpadAccount.Call({
            target: token,
            value: 0,
            data: abi.encodeCall(IERC20PonsFork.approve, (curve, tokensOut))
        });
        sellCalls[1] = IPrivateLaunchpadAccount.Call({
            target: curve,
            value: 0,
            data: abi.encodeCall(IPonsV2CurveFork.sell, (tokensOut, 1, predicted))
        });
        bytes memory sellSignature = _sign(predicted, sellCalls, 2, deadline, 0);
        vm.prank(relayer);
        bytes[] memory sellResults =
            account.execute(sellCalls, 2, deadline, address(0), 0, address(0), sellSignature);
        uint256 quoteOut = abi.decode(sellResults[1], (uint256));
        assertGt(quoteOut, 0);
        assertEq(IERC20PonsFork(token).balanceOf(predicted), 0);
        assertGt(IERC20PonsFork(USDG).balanceOf(predicted), 99e6);
    }

    function _sign(
        address verifyingAccount,
        IPrivateLaunchpadAccount.Call[] memory calls,
        uint256 nonce,
        uint256 executionDeadline,
        uint256 prefund
    ) internal view returns (bytes memory signature) {
        return _signWithName(
            verifyingAccount, calls, nonce, executionDeadline, prefund, "PrivateLaunchpadAccount"
        );
    }

    function _signWithName(
        address verifyingAccount,
        IPrivateLaunchpadAccount.Call[] memory calls,
        uint256 nonce,
        uint256 executionDeadline,
        uint256 prefund,
        string memory domainName
    ) internal view returns (bytes memory signature) {
        bytes32[] memory callHashes = new bytes32[](calls.length);
        bytes32 callTypehash = keccak256("Call(address target,uint256 value,bytes data)");
        for (uint256 i; i < calls.length; ++i) {
            callHashes[i] = keccak256(
                abi.encode(callTypehash, calls[i].target, calls[i].value, keccak256(calls[i].data))
            );
        }
        bytes32 domain = keccak256(
            abi.encode(
                keccak256(
                    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
                ),
                keccak256(bytes(domainName)),
                keccak256("1"),
                block.chainid,
                verifyingAccount
            )
        );
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256(
                    "Execution(bytes32 callsHash,uint256 nonce,uint256 deadline,address feeToken,uint256 feeAmount,address feeRecipient,uint256 prefund)"
                ),
                keccak256(abi.encodePacked(callHashes)),
                nonce,
                executionDeadline,
                address(0),
                0,
                address(0),
                prefund
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domain, structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(OWNER_KEY, digest);
        signature = abi.encodePacked(r, s, v);
    }
}
