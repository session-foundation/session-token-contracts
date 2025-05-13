// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.26;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import "./libraries/arbitrum-bridge/IArbToken.sol";

/**
 * @title SESHL2 Token
 * @notice L2 representation of the SESH token, bridged from L1
 */
contract SESHL2 is Initializable, ERC20Upgradeable, IArbToken {

    uint256 public constant VERSION = 2;

    address public l2Gateway;
    address public l1Address;

    modifier onlyL2Gateway() {
        require(msg.sender == l2Gateway, "NOT_GATEWAY");
        _;
    }

    /**
     * @notice Initializes the L2 token with the same name, symbol, and decimals as L1.
     * @param l2Gateway_ The L2 gateway that interacts with the Arbitrum bridge.
     * @param l1Address_ The corresponding L1 token address.
     */
    function initialize(address l2Gateway_, address l1Address_) public initializer {
        // Initialize state variables.
        l2Gateway = l2Gateway_;
        l1Address = l1Address_;

        // Initialize ERC20 with token name and symbol.
        __ERC20_init("Session Token", "SESH");
    }

    /**
     * @notice Returns the number of decimals used to get its user representation.
     * @return The number of decimals (9)
     */
    function decimals() public pure override returns (uint8) {
        return 9;
    }

    /**
     * @notice Increases the token supply by minting tokens.
     * @param account The account that will receive the minted tokens.
     * @param amount The amount of tokens to mint.
     */
    function bridgeMint(address account, uint256 amount) external override onlyL2Gateway {
        _mint(account, amount);
    }

    /**
     * @notice Decreases the token supply by burning tokens.
     * @param account The account whose tokens will be burned.
     * @param amount The amount of tokens to burn.
     */
    function bridgeBurn(address account, uint256 amount) external override onlyL2Gateway {
        _burn(account, amount);
    }
}
