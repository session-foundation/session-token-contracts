// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";

contract TokenConverter is Ownable, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    IERC20 public immutable tokenA;
    IERC20 public immutable tokenB;
    uint256 public conversionRateNumerator;
    uint256 public conversionRateDenominator;

    event Conversion(address indexed user, uint256 amountA, uint256 amountB);
    event RateUpdated(uint256 numerator, uint256 denominator);
    event TokenBDeposited(uint256 amount);
    event TokenBWithdrawn(uint256 amount);

    constructor(
        address _tokenA,
        address _tokenB,
        uint256 _initialNumerator,
        uint256 _initialDenominator
    ) Ownable(msg.sender) Pausable() {
        require(_tokenA != address(0) && _tokenB != address(0), "Invalid token address");
        require(_initialNumerator > 0 && _initialDenominator > 0, "Conversion rate must be greater than 0");

        tokenA = IERC20(_tokenA);
        tokenB = IERC20(_tokenB);
        conversionRateNumerator = _initialNumerator;
        conversionRateDenominator = _initialDenominator;
    }

    function updateConversionRate(uint256 _newNumerator, uint256 _newDenominator) external onlyOwner {
        require(_newNumerator > 0 && _newDenominator > 0, "Conversion rate components must be greater than 0");
        conversionRateNumerator = _newNumerator;
        conversionRateDenominator = _newDenominator;
        emit RateUpdated(_newNumerator, _newDenominator);
    }

    function depositTokenB(uint256 _amount) external onlyOwner {
        require(_amount > 0, "Amount must be greater than 0");
        emit TokenBDeposited(_amount);
        tokenB.safeTransferFrom(msg.sender, address(this), _amount);
    }

    function withdrawTokenB(uint256 _amount) external onlyOwner {
        require(_amount > 0, "Amount must be greater than 0");
        require(tokenB.balanceOf(address(this)) >= _amount, "Insufficient balance");
        emit TokenBWithdrawn(_amount);
        tokenB.safeTransfer(msg.sender, _amount);
    }

    function convertTokens(uint256 _amountA) external nonReentrant whenNotPaused {
        require(_amountA > 0, "Amount must be greater than 0");
        uint256 amountB = (_amountA * conversionRateNumerator) / conversionRateDenominator;
        require(tokenB.balanceOf(address(this)) >= amountB, "Insufficient Token B in contract");
        emit Conversion(msg.sender, _amountA, amountB);
        tokenA.safeTransferFrom(msg.sender, address(this), _amountA);
        tokenB.safeTransfer(msg.sender, amountB);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }
}
