// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

/**
 * @title Reward Rate Pool Contract
 * @dev Implements reward distribution based on a fixed simple annual payout rate.
 */
contract RewardRatePool is Initializable, Ownable2StepUpgradeable {
    using SafeERC20 for IERC20;

    uint256 public constant VERSION = 1;

    // solhint-disable-next-line var-name-mixedcase
    IERC20 public SESH;

    address public beneficiary;
    uint256 public totalPaidOut;
    uint256 public lastPaidOutTime;
    // The simple annual payout rate used for reward calculations.  This 15.1% value is chosen so
    // that, with daily payouts computed at this simple rate, the total (compounded) payout over a
    // year will equal 14% of the amount that was in the pool at the beginning of the year.
    //
    // To elaborate where this comes from, with daily payout r (=R/365, that is, the annual payout
    // divided by 365 days per year), with starting balance P, the payout on day 1 equals:
    //     rP
    // leaving P-rP = (1-r)P in the pool, and so the day 2 payout equals:
    //     r(1-r)P
    // leaving (1-r)P - r(1-r)P = (1-r)(1-r)P = (1-r)^2 P in the pool.  And so on, so that
    // after 365 days there will be (1-r)^365 P left in the pool.
    //
    // To hit a target of 14% over a year, then, we want to find r to solve:
    //     (1-r)^{365} P = (1-.14) P
    // i.e.
    //     (1-r)^{365} = 0.86
    // and then we multiply the `r` solution by 365 to get the simple annual rate with daily
    // payouts.  Rounded to the nearest 10th of a percent, that value equals 0.151, i.e. 15.1%.
    //
    // There is, of course, some slight imprecision here from the rounding and because the precise
    // payout frequency depends on the times between calling this smart contract, but the errors are
    // expected to be small, keeping this close to the 14% target.
    uint64 public constant ANNUAL_SIMPLE_PAYOUT_RATE = 151; // 15.1% in tenths of a percent
    uint64 public constant BASIS_POINTS = 1000; // Basis points for percentage calculation

    /**
     * @dev Sets the initial beneficiary and SESH token address.
     * @param _beneficiary Address that will receive the payouts.
     * @param _sesh Address of the SESH ERC20 token contract.
     */
    function initialize(address _beneficiary, address _sesh) public initializer {
        beneficiary = _beneficiary;
        lastPaidOutTime = block.timestamp;
        SESH = IERC20(_sesh);
        __Ownable_init(msg.sender);
    }

    // EVENTS
    event FundsReleased(uint256 amount);
    event BeneficiaryUpdated(address newBeneficiary);

    //////////////////////////////////////////////////////////////
    //                                                          //
    //                  State-changing functions                //
    //                                                          //
    //////////////////////////////////////////////////////////////

    /**
     * @dev Calculates and releases the due payout to the beneficiary.
     * Updates the total paid out and the last payout time.
     */
    function payoutReleased() public {
        uint256 newTotalPaidOut = calculateReleasedAmount();
        uint256 released = newTotalPaidOut - totalPaidOut;
        totalPaidOut = newTotalPaidOut;
        lastPaidOutTime = block.timestamp;
        emit FundsReleased(released);
        SESH.safeTransfer(beneficiary, released);
    }

    /// @notice Setter function for beneficiary, only callable by owner
    /// @param newBeneficiary the address the beneficiary is being changed to
    function setBeneficiary(address newBeneficiary) public onlyOwner {
        beneficiary = newBeneficiary;
        emit BeneficiaryUpdated(newBeneficiary);
    }

    //////////////////////////////////////////////////////////////
    //                                                          //
    //                Non-state-changing functions              //
    //                                                          //
    //////////////////////////////////////////////////////////////

    /**
     * @dev Returns the current 2-minute block reward.
     * @return The calculated block reward.
     */
    function rewardRate() public view returns (uint256) {
        uint256 alreadyReleased = calculateReleasedAmount();
        uint256 totalDeposited = calculateTotalDeposited();
        return calculatePayoutAmount(totalDeposited - alreadyReleased, 2 minutes);
    }

    /**
     * @dev Calculates the total amount of SESH tokens deposited in the contract.
     * @return The sum of SESH tokens currently held by the contract and the total amount previously paid out.
     */
    function calculateTotalDeposited() public view returns (uint256) {
        return SESH.balanceOf(address(this)) + totalPaidOut;
    }

    /**
     * @dev Calculates the amount of SESH tokens released up to the current time.
     * @return The calculated amount of SESH tokens released.
     */
    function calculateReleasedAmount() public view returns (uint256) {
        uint256 timeElapsed = block.timestamp - lastPaidOutTime;
        return totalPaidOut + calculatePayoutAmount(SESH.balanceOf(address(this)), timeElapsed);
    }

    /**
     * @dev Calculates payout amount for a given balance and time period.
     * @param balance The principal balance to calculate payout from.
     * @param timeElapsed The time period over which to calculate payout.
     * @return The calculated payout amount.
     */
    function calculatePayoutAmount(uint256 balance, uint256 timeElapsed) public pure returns (uint256) {
        return (balance * ANNUAL_SIMPLE_PAYOUT_RATE * timeElapsed) / (BASIS_POINTS * 365 days);
    }
}
