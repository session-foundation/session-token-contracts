// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.26;

import "./libraries/Shared.sol";
import "./interfaces/IServiceNodeRewards.sol";
import "./interfaces/IServiceNodeContribution.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title Service Node Contribution Contract
///
/// @dev This contract allows for the collection of contributions towards
/// a service node. Operators usually generate one of these smart contracts using
/// the parent factory contract `ServiceNodeContributionFactory` for each service
/// node they start and wish to collateralise with funds from the public.
///
/// Contributors can fund the service node until the staking requirement is met.
/// Once the staking requirement is met, the contract is automatically finalized
/// and send the service node registration `ServiceNodeRewards` contract.
///
/// This contract supports revoking of the contract prior to finalisation,
/// refunding the contribution to the contributors and the operator.
contract ServiceNodeContribution is Shared, IServiceNodeContribution {
    // Definitions
    using SafeERC20 for IERC20;

    // Staking
    // solhint-disable-next-line var-name-mixedcase
    IERC20                                        public immutable SESH;
    IServiceNodeRewards                           public immutable stakingRewardsContract;
    uint256                                       public immutable stakingRequirement;

    // Service Node
    BN256G1.G1Point                               public blsPubkey;
    IServiceNodeRewards.ServiceNodeParams         public _serviceNodeParams;
    IServiceNodeRewards.BLSSignatureParams        public _blsSignature;

    // Contributions
    address                                       public immutable operator;
    mapping(address stakerAddr => uint256 amount) public           contributions;
    mapping(address stakerAddr => uint256 amount) public           contributionTimestamp;
    IServiceNodeRewards.Staker[]                  public           _contributorAddresses;
    uint256                                       public immutable maxContributors;

    // Reserved Stakes
    mapping(address stakerAddr => ReservedContribution) public reservedContributions;
    address[]                                           public reservedContributionsAddresses;

    // Smart Contract
    Status                                        public          status           = Status.WaitForOperatorContrib;
    uint64                                        public constant WITHDRAWAL_DELAY = 1 days;
    uint16                                        public constant MAX_FEE          = 10000;

    // Prevents the contract from automatically invoking `finalize` when a
    // contribution to the contract fulfills the staking requirement. When true,
    // the operator must manually invoke `finalize` which transfers the stake
    // and registers the node to the `stakingRewardsContract`
    //
    // By default, this flag is false which makes the finalize step
    // automatic when the staking requirement is fulfilled (including when
    // a public contributor fulfills the node).
    bool public manualFinalize;

    // Modifiers
    modifier onlyOperator() {
        if (msg.sender != operator)
            revert OnlyOperatorIsAuthorised(msg.sender, operator);
        _;
    }

    modifier requireWaitForOperatorContribStatus() {
        if (status != Status.WaitForOperatorContrib)
            revert RequireWaitForOperatorContribStatus(status);
        _;
    }

    /// @notice Constructs a multi-contribution node contract for the
    /// specified `_stakingRewardsContract`.
    ///
    /// @dev This contract should typically be invoked from the parent
    /// contribution factory `ServiceNodeContributionFactory`.
    ///
    /// @param _stakingRewardsContract Address of the staking rewards contract.
    /// @param _maxContributors Maximum number of contributors allowed.
    /// @param key 64 byte BLS public key for the node.
    /// @param sig 128 byte BLS proof-of-posession signature that proves the
    /// caller knows the secret component of `key`.
    /// @param params Node registration parameters including the Ed25519 public
    /// key, a signature and the fee the operator is charging.
    /// @param reserved The new array of reserved contributors with their
    /// proportion of stake they must fulfill in the node.
    /// @param _manualFinalize Configure if the contract automatically (or does
    /// not) finalize the contract upon receipt of a contribution that
    /// funds the total required staking requirement of the contract.
    /// Finalisation being the registration of the node on
    /// `stakingRewardsContract`
    constructor(
        address _stakingRewardsContract,
        uint256 _maxContributors,
        BN256G1.G1Point memory key,
        IServiceNodeRewards.BLSSignatureParams memory sig,
        IServiceNodeRewards.ServiceNodeParams memory params,
        IServiceNodeRewards.ReservedContributor[] memory reserved,
        bool _manualFinalize
    ) nzAddr(_stakingRewardsContract) nzUint(_maxContributors) {
        stakingRewardsContract = IServiceNodeRewards(_stakingRewardsContract);
        stakingRequirement     = stakingRewardsContract.stakingRequirement();
        SESH                   = IERC20(stakingRewardsContract.designatedToken());
        maxContributors        = _maxContributors;
        operator               = tx.origin; // NOTE: Creation is delegated by operator through factory
        address nilBeneficiary = address(0);
        _resetUpdateAndContribute(key, sig, params, reserved, _manualFinalize, nilBeneficiary, 0);
    }

    //////////////////////////////////////////////////////////////
    //                                                          //
    //                  State-changing functions                //
    //                                                          //
    //////////////////////////////////////////////////////////////

    function updateManualFinalize(bool value) external onlyOperator { _updateManualFinalize(value); }

    function _updateManualFinalize(bool value) private {
        manualFinalize = value;
        emit UpdateManualFinalize(value);
    }

    function updateFee(uint16 fee) external onlyOperator { _updateFee(fee); }

    function _updateFee(uint16 fee) private requireWaitForOperatorContribStatus {
        if (fee > MAX_FEE)
            revert FeeExceedsPossibleValue(fee, MAX_FEE);
        _serviceNodeParams.fee = fee;

        emit UpdateFee(fee);
    }

    function updatePubkeys(BN256G1.G1Point memory newBLSPubkey,
                           IServiceNodeRewards.BLSSignatureParams memory newBLSSig,
                           uint256 ed25519Pubkey,
                           uint256 ed25519Sig0,
                           uint256 ed25519Sig1) external onlyOperator {
        _updatePubkeys(newBLSPubkey, newBLSSig, ed25519Pubkey, ed25519Sig0, ed25519Sig1);
    }

    function _updatePubkeys(BN256G1.G1Point memory newBLSPubkey,
                            IServiceNodeRewards.BLSSignatureParams memory newBLSSig,
                            uint256 ed25519Pubkey,
                            uint256 ed25519Sig0,
                            uint256 ed25519Sig1) private requireWaitForOperatorContribStatus {
        stakingRewardsContract.validateProofOfPossession(newBLSPubkey, newBLSSig, operator, ed25519Pubkey);

        // NOTE: Update BLS keys
        blsPubkey                               = newBLSPubkey;
        _blsSignature                            = newBLSSig;

        // NOTE: Update Ed25519 keys
        _serviceNodeParams.serviceNodePubkey     = ed25519Pubkey;
        _serviceNodeParams.serviceNodeSignature1 = ed25519Sig0;
        _serviceNodeParams.serviceNodeSignature2 = ed25519Sig1;

        emit UpdatePubkeys(newBLSPubkey, ed25519Pubkey);
    }

    function updateReservedContributors(IServiceNodeRewards.ReservedContributor[] memory reserved) external onlyOperator {
        _updateReservedContributors(reserved);
    }

    function _updateReservedContributors(IServiceNodeRewards.ReservedContributor[] memory reserved) private requireWaitForOperatorContribStatus {
        // NOTE: Remove old reserved contributions
        {
            uint256 length = reservedContributionsAddresses.length;
            for (uint256 i = 0; i < length; ) {
                delete reservedContributions[reservedContributionsAddresses[i]];
                unchecked { i += 1; }
            }
            delete reservedContributionsAddresses;
        }

        // NOTE: Assign new contributions and verify them
        uint256 remaining = stakingRequirement;

        if (reserved.length > maxContributors)
            revert TooManyReservedContributors(reserved.length, maxContributors);

        uint256 reservedLength = reserved.length;
        for (uint256 i = 0; i < reservedLength; ) {
            if (i == 0) {
                if (reserved[i].addr != operator)
                    revert FirstReservedContributorMustBeOperator(i, operator);
            }

            if (reserved[i].addr == address(0))
                revert ReservedContributorHasZeroAddress(i);

            ReservedContribution storage contribution = reservedContributions[reserved[i].addr];
            if (contribution.amount != 0)
                revert DuplicateAddressInReservedContributor(i);

            // NOTE: Check contribution meets min requirements and running sum
            // doesn't exceed a full stake
            uint256 minContrib     = calcMinimumContribution(remaining, i, maxContributors);
            uint256 contribAmount  = reserved[i].amount;

            if (contribAmount < minContrib)
                revert ReservedContributionBelowMinAmount(i, contribAmount, minContrib);

            if (remaining < contribAmount)
                revert ReservedContributionExceedsStakingRequirement(i, contribAmount, remaining);

            remaining -= contribAmount;

            // NOTE: Store the reservation in the contract
            reservedContributionsAddresses.push(reserved[i].addr);
            contribution.amount   = contribAmount;
            contribution.received = false;

            unchecked { i += 1; }
        }

        emit UpdateReservedContributors(reserved);
    }

    // @notice Select the beneficiary as the `beneficiary` is not the
    // zero-address. Otherwise the derived beneficiary is set to `caller`.
    function deriveBeneficiary(address caller, address beneficiary) private pure returns (address result) {
        result = beneficiary == address(0) ? caller : beneficiary;
    }

    function updateBeneficiary(address newBeneficiary) external { _updateBeneficiary(msg.sender, newBeneficiary); }

    function _updateBeneficiary(address stakerAddr, address newBeneficiary) private {
        if (status != Status.OpenForPublicContrib && status != Status.WaitForFinalized)
            revert BeneficiaryUpdatingDisabledNodeIsNotOpen(_serviceNodeParams.serviceNodePubkey);

        address desiredBeneficiary = deriveBeneficiary(stakerAddr, newBeneficiary);
        address oldBeneficiary     = address(0);
        bool updated               = false;
        uint256 length             = _contributorAddresses.length;
        for (uint256 i = 0; i < length; ) {
            IServiceNodeRewards.Staker storage staker = _contributorAddresses[i];
            if (staker.addr == stakerAddr) {
                if (staker.beneficiary == desiredBeneficiary)
                    return;

                updated            = true;
                oldBeneficiary     = staker.beneficiary;
                staker.beneficiary = desiredBeneficiary;
                break;
            }

            unchecked { i += 1; }
        }

        if (!updated)
            revert NonContributorUpdatedBeneficiary(stakerAddr);

        emit UpdateStakerBeneficiary(stakerAddr, desiredBeneficiary);
    }

    function contributeFunds(uint256 amount, address beneficiary) external { _contributeFunds(msg.sender, beneficiary, amount); }

    function _contributeFunds(address caller, address beneficiary, uint256 amount) private {
        if (status != Status.WaitForOperatorContrib && status != Status.OpenForPublicContrib)
            revert ContributeFundsNotPossible(status);

        // NOTE: Check if parent contract invariants changed
        if (maxContributors != stakingRewardsContract.maxContributors())
            revert RewardsContractMaxContributorsChanged(maxContributors, stakingRewardsContract.maxContributors());

        if (stakingRequirement != stakingRewardsContract.stakingRequirement())
            revert RewardsContractMaxContributorsChanged(stakingRequirement, stakingRewardsContract.stakingRequirement());

        // NOTE: Handle operator contribution, initially the operator must contribute to open the
        // contract up to public/reserved contributions.
        if (status == Status.WaitForOperatorContrib) {
            if (caller != operator)
                revert FirstContributionMustBeOperator(caller, operator);
            status = Status.OpenForPublicContrib;
            emit OpenForPublicContribution();
        }

        // NOTE: Verify the contribution
        ReservedContribution storage reserved = reservedContributions[caller];
        if (reserved.amount > 0 && !reserved.received) {
            // NOTE: Check amount is sufficient
            if (amount < reserved.amount)
                revert ContributionBelowReservedAmount(amount, reserved.amount);

            // NOTE: Mark their contribution as having been received
            reserved.received = true;
        } else {
            // NOTE: Check amount is greater than the minimum contribution only
            // if they have not contributed before (otherwise we allow
            // topping-up of their contribution).
            if (contributions[caller] == 0 && amount < minimumContribution())
                revert ContributionBelowMinAmount(amount, minimumContribution());
        }

        // NOTE: Add the contributor to the contract
        if (contributions[caller] == 0) {
            address desiredBeneficiary = deriveBeneficiary(caller, beneficiary);
            _contributorAddresses.push(IServiceNodeRewards.Staker(caller, desiredBeneficiary));
        } else {
            _updateBeneficiary(caller, beneficiary);
        }

        // NOTE: Update the amount contributed and transfer the tokens
        contributions[caller]         += amount;
        contributionTimestamp[caller]  = block.timestamp;

        // NOTE: Check contract collateralisation _after_ the amount is
        // committed to the contract to ensure contribution sums are all
        // accounted for.
        uint256 currTotalContribution    = totalContribution();
        uint256 currReservedContribution = totalReservedContribution();
        if ((currTotalContribution + currReservedContribution) > stakingRequirement)
            revert ContributionExceedsStakingRequirement(currTotalContribution, currReservedContribution, stakingRequirement);

        if (_contributorAddresses.length > maxContributors)
            revert MaxContributorsExceeded(maxContributors);

        // NOTE: Allow finalizing the node if the staking requirement is met
        // State transition before calling out to external code to mitigate
        // re-entrancy.
        if (currTotalContribution == stakingRequirement) {
            status = Status.WaitForFinalized;
            emit Filled();
        }

        // NOTE: Transfer funds from sender to contract
        emit NewContribution(caller, amount);
        SESH.safeTransferFrom(caller, address(this), amount);

        // NOTE: Auto finalize the node if valid
        if (status == Status.WaitForFinalized && !manualFinalize) {
            _finalize();
        }
    }

    function finalize() external onlyOperator { _finalize(); }

    function _finalize() private {
        if (status != Status.WaitForFinalized)
            revert FinalizeNotPossible(status);

        // NOTE: Finalize the contract
        status = Status.Finalized;
        emit Finalized();

        uint256 length                                        = _contributorAddresses.length;
        IServiceNodeRewards.Contributor[] memory contributors = new IServiceNodeRewards.Contributor[](length);
        for (uint256 i = 0; i < length; ) {
            IServiceNodeRewards.Staker storage entry = _contributorAddresses[i];
            contributors[i]                          = IServiceNodeRewards.Contributor(entry, contributions[entry.addr]);
            unchecked { i += 1; }
        }

        // NOTE: Transfer tokens and register the node on the `stakingRewardsContract`
        SESH.approve(address(stakingRewardsContract), stakingRequirement);
        stakingRewardsContract.addBLSPublicKey(blsPubkey, _blsSignature, _serviceNodeParams, contributors);
    }

    function reset() external onlyOperator { _reset(); }

    /// @notice See `reset`
    function _reset() private {
        // NOTE: Remove contributor data stored in maps, refund any tokens they
        // contributed, if any
        uint256 length = _contributorAddresses.length;
        for (uint256 i = 0; i < length; ) {
            address toRemove = _contributorAddresses[i].addr;
            uint256 refund   = contributions[toRemove];
            if (status != Status.Finalized && refund > 0)
                SESH.safeTransfer(toRemove, refund);
            clearContributorMapData(toRemove);
            unchecked { i += 1; }
        }

        // NOTE: Delete contributor array
        delete _contributorAddresses;

        // NOTE: Reset left-over contract variables
        status = Status.WaitForOperatorContrib;

        // NOTE: Remove all reserved contributions
        {
            IServiceNodeRewards.ReservedContributor[] memory zero = new IServiceNodeRewards.ReservedContributor[](0);
            _updateReservedContributors(zero);
        }

        emit Reset();
    }

    function resetUpdateAndContribute(BN256G1.G1Point memory key,
                                      IServiceNodeRewards.BLSSignatureParams memory sig,
                                      IServiceNodeRewards.ServiceNodeParams memory params,
                                      IServiceNodeRewards.ReservedContributor[] memory reserved,
                                      bool _manualFinalize,
                                      address beneficiary,
                                      uint256 amount) external onlyOperator {
        _resetUpdateAndContribute(key, sig, params, reserved, _manualFinalize, beneficiary, amount);
    }

    function _resetUpdateAndContribute(BN256G1.G1Point memory key,
                                       IServiceNodeRewards.BLSSignatureParams memory sig,
                                       IServiceNodeRewards.ServiceNodeParams memory params,
                                       IServiceNodeRewards.ReservedContributor[] memory reserved,
                                       bool _manualFinalize,
                                       address beneficiary,
                                       uint256 amount) private {
        _reset();
        _updatePubkeys(key, sig, params.serviceNodePubkey, params.serviceNodeSignature1, params.serviceNodeSignature2);
        _updateFee(params.fee);
        _updateReservedContributors(reserved);
        _updateManualFinalize(_manualFinalize);
        if (amount > 0)
            _contributeFunds(operator, beneficiary, amount);
    }

    function rescueERC20(address tokenAddress) external onlyOperator {
        // NOTE: ERC20 tokens sent to the contract can only be rescued after the
        // contract is finalized or the contract has been reset
        // because:
        //
        //   The contract is not funded by any contributor/operator (e.g: It was
        //   just reset) (status == WaitForOperatorContrib)
        //     OR
        //   The funds have been transferred to the SN rewards contract
        //   (status == Finalized)
        //
        // This allows them to refund any other tokens that might have
        // mistakenly been sent throughout the lifetime of the contract without
        // giving them access to contributor tokens.
        if (status == Status.Finalized || status == Status.WaitForOperatorContrib) {
            IERC20 token = IERC20(tokenAddress);
            uint256 balance = token.balanceOf(address(this));
            if (balance <= 0)
                revert RescueBalanceIsEmpty(tokenAddress);
            token.safeTransfer(operator, balance);
        } else {
            revert RescueNotPossible(status);
        }

    }

    function withdrawContribution() external {
        if (msg.sender == operator) {
            _reset();
            return;
        }

        uint256 timeSinceLastContribution = block.timestamp - contributionTimestamp[msg.sender];
        if (timeSinceLastContribution < WITHDRAWAL_DELAY)
            revert WithdrawTooEarly(contributionTimestamp[msg.sender], block.timestamp, WITHDRAWAL_DELAY);

        uint256 refundAmount = removeAndRefundContributor(msg.sender);
        if (refundAmount > 0)
            emit WithdrawContribution(msg.sender, refundAmount);
    }

    /// @notice Delete data stored for a contributor in the contract's hash
    /// tables.
    function clearContributorMapData(address contributor) private {
        delete contributions[contributor];
        delete contributionTimestamp[contributor];
    }

    /// @dev Remove the contributor by address specified by `toRemove` from the
    /// smart contract. This updates all contributor related smart contract
    /// variables including the:
    ///
    ///   1) Removing contributor from contribution mapping
    ///   2) Removing their address from the contribution array
    ///   3) Resetting the addresses reservation amounts (if applicable)
    ///   4) Refunding the SESH amount contributed to the contributor
    ///
    /// @return result The amount of SESH refunded for the given `toRemove`
    /// address. If `toRemove` is not a contributor/does not exist, 0 is returned
    /// as the refunded amount.
    function removeAndRefundContributor(address toRemove) private returns (uint256 result) {
        result = contributions[toRemove];
        if (result == 0)
            return result;

        // 1) Removing contributor from contribution mapping
        clearContributorMapData(toRemove);

        // 2) Removing their address from the contribution array
        uint256 length = _contributorAddresses.length;
        for (uint256 i = 0; i < length; ) {
            if (toRemove == _contributorAddresses[i].addr) {
                _contributorAddresses[i] = _contributorAddresses[length - 1];
                _contributorAddresses.pop();
                break;
            }
            unchecked { i += 1; }
        }

        // 3) Resetting the addresses reservation 'received' mark (if applicable)
        ReservedContribution storage reserved = reservedContributions[toRemove];
        reserved.received                     = false;

        // 4) Refunding the SESH amount contributed to the contributor
        if (status == Status.Finalized) {
            // NOTE: Funds have been transferred out already, we just needed to
            // clean up the contract book-keeping for `toRemove`.
            result = 0;
        } else {
            SESH.safeTransfer(toRemove, result);

            // NOTE: Reopen the contract for contribution if we were previously
            // ready to be finalized (e.g. fully collateralised)
            if (status == Status.WaitForFinalized)
                status = Status.OpenForPublicContrib;
        }

        return result;
    }

    //////////////////////////////////////////////////////////////
    //                                                          //
    //                Non-state-changing functions              //
    //                                                          //
    //////////////////////////////////////////////////////////////

    function blsSignature() external view returns (IServiceNodeRewards.BLSSignatureParams memory) {
        return _blsSignature;
    }

    function serviceNodeParams() external view returns (IServiceNodeRewards.ServiceNodeParams memory) {
        return _serviceNodeParams;
    }

    function contributorAddresses(uint256 index) external view returns (IServiceNodeRewards.Staker memory) {
        return _contributorAddresses[index];
    }

    function minimumContribution() public view returns (uint256 result) {

        // NOTE: Enumerate the reservations that have not contributed yet. Use
        // this information to calculate the minimum (accounting for the
        // reserved contributors that have already filled their part or _yet_ to
        // fill their part).
        uint256 reservedAmountAwaitingContribution                = 0;
        uint256 reservedContributorThatHaveNotContributedYetCount = 0;
        uint256 reservedLength                                    = reservedContributionsAddresses.length;
        for (uint256 i = 0; i < reservedLength; ) {
            address reservedAddr                  = reservedContributionsAddresses[i];
            ReservedContribution storage reserved = reservedContributions[reservedAddr];
            if (!reserved.received) {
                reservedAmountAwaitingContribution                += reserved.amount;
                reservedContributorThatHaveNotContributedYetCount += 1;
            }
            unchecked { i += 1; }
        }

        // NOTE: Calculate the minimum
        result = calcMinimumContribution(
            stakingRequirement - totalContribution() - reservedAmountAwaitingContribution,
            _contributorAddresses.length + reservedContributorThatHaveNotContributedYetCount,
            maxContributors
        );
        return result;
    }

    function calcMinimumContribution(
        uint256 contributionRemaining,
        uint256 numContributors,
        uint256 maxNumContributors
    ) public pure returns (uint256 result) {
        if (maxNumContributors <= numContributors)
            revert CalcMinContributionGivenBadContribArgs(numContributors, maxNumContributors);

        if (numContributors == 0) {
            result = ((contributionRemaining - 1) / 4) + 1; // math.ceilDiv(25% of requirement)
        } else {
            uint256 slotsRemaining = maxNumContributors - numContributors;
            result = (contributionRemaining - 1) / slotsRemaining + 1;
        }
        return result;
    }

    /// @notice Calculates the minimum operator contribution given the staking
    /// requirement.
    function minimumOperatorContribution(uint256 _stakingRequirement) public pure returns (uint256 result) {
        result = calcMinimumContribution(_stakingRequirement, 0, 1);
        return result;
    }

    /// @dev This function allows unit-tests to query the length without having
    /// to know the storage slot of the array size.
    function contributorAddressesLength() public view returns (uint256 result) {
        result = _contributorAddresses.length;
        return result;
    }

    /// @notice Get the contribution by the operator, defined to always be the
    /// first contribution in the contract.
    function operatorContribution() public view returns (uint256 result) {
        result = _contributorAddresses.length > 0 ? contributions[_contributorAddresses[0].addr] : 0;
        return result;
    }

    /// @notice Access the list of contributor addresses and corresponding
    /// contributions. The first returned address (if any) is also the operator
    /// address.
    function getContributions() public view returns (address[] memory addrs, address[] memory beneficiaries, uint256[] memory contribs) {
        uint256 length = _contributorAddresses.length;
        addrs          = new address[](length);
        beneficiaries  = new address[](length);
        contribs       = new uint256[](length);
        for (uint256 i = 0; i < length; ) {
            IServiceNodeRewards.Staker storage staker = _contributorAddresses[i];
            addrs[i]                                  = staker.addr;
            beneficiaries[i]                          = staker.beneficiary;
            contribs[i]                               = contributions[addrs[i]];
            unchecked { i += 1; }
        }
        return (addrs, beneficiaries, contribs);
    }

    /// @notice Access the list of reserved addresses and corresponding
    /// contributions. The first returned address (if any) is also the operator
    /// address.
    function getReserved() public view returns (address[] memory addrs, uint256[] memory contribs, bool[] memory received) {
        uint256 length = reservedContributionsAddresses.length;
        addrs          = new address[](length);
        contribs       = new uint256[](length);
        received       = new bool[](length);
        for (uint256 i = 0; i < length; ) {
            address reservedAddr                  = reservedContributionsAddresses[i];
            ReservedContribution storage reserved = reservedContributions[reservedAddr];
            addrs[i]                              = reservedAddr;
            contribs[i]                           = reserved.amount;
            received[i]                           = reserved.received;
            unchecked { i += 1; }
        }
        return (addrs, contribs, received);
    }

    /// @notice Sum up all the contributions recorded in the contributors list
    function totalContribution() public view returns (uint256 result) {
        uint256 length = _contributorAddresses.length;
        for (uint256 i = 0; i < length; ) {
            address entry  = _contributorAddresses[i].addr;
            result        += contributions[entry];
            unchecked { i += 1; }
        }
        return result;
    }

    /// @notice Sum up all the reserved contributions recorded in the reserved
    /// list that haven't contributed to the contract yet
    function totalReservedContribution() public view returns (uint256 result) {
        uint256 length = reservedContributionsAddresses.length;
        for (uint256 i = 0; i < length; ) {
            address entry                         = reservedContributionsAddresses[i];
            ReservedContribution storage reserved = reservedContributions[entry];
            if (!reserved.received)
                result += reserved.amount;
            unchecked { i += 1; }
        }
        return result;
    }
}
