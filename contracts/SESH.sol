// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import "./libraries/arbitrum-bridge/ICustomToken.sol";
import "./libraries/arbitrum-bridge/IGateways.sol";
import "./libraries/Shared.sol";

/**
 * @title SESH contract
 * @notice The SESH utility token with Arbitrum Custom Gateway support
 */
contract SESH is ICustomToken, ERC20, ERC20Permit, Shared {
    uint256 public constant VERSION = 1;

    address public immutable gateway;
    address public immutable router;
    bool private shouldRegisterGateway;

    constructor(
        uint256 totalSupply_,
        address receiverGenesisAddress,
        address _gateway,
        address _router
     ) ERC20("Session Token", "SESH") ERC20Permit("Session Token") nzAddr(receiverGenesisAddress) nzUint(totalSupply_) {
        _mint(receiverGenesisAddress, totalSupply_);
        gateway = _gateway;
        router = _router;
    }

    function decimals() public pure override returns (uint8) {
        return 9;
    }

    /// @notice Returns `0xb1` to indicate the token is Arbitrum enabled
    function isArbitrumEnabled() external view override returns (uint8) {
        require(shouldRegisterGateway, "NOT_EXPECTED_CALL");
        return uint8(0xb1);
    }

    /// @notice Register token on L2 via the Arbitrum Custom Gateway
    function registerTokenOnL2(
        address l2CustomTokenAddress,
        uint256 maxSubmissionCostForCustomGateway,
        uint256 maxSubmissionCostForRouter,
        uint256 maxGasForCustomGateway,
        uint256 maxGasForRouter,
        uint256 gasPriceBid,
        uint256 valueForGateway,
        uint256 valueForRouter,
        address creditBackAddress
    ) public payable override {
        bool prev = shouldRegisterGateway;
        shouldRegisterGateway = true;

        IL1CustomGateway(gateway).registerTokenToL2{ value: valueForGateway }(
            l2CustomTokenAddress,
            maxGasForCustomGateway,
            gasPriceBid,
            maxSubmissionCostForCustomGateway,
            creditBackAddress
        );

        IL2GatewayRouter(router).setGateway{ value: valueForRouter }(
            gateway,
            maxGasForRouter,
            gasPriceBid,
            maxSubmissionCostForRouter,
            creditBackAddress
        );

        shouldRegisterGateway = prev;
    }
}

