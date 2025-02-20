// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.26;

import "./IServiceNodeRewards.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IServiceNodeContribution {
    // Definitions
    // Track the status of the multi-contribution contract. At any point in the
    // contract's lifetime, `reset` can be invoked to set the contract back to
    // `WaitForOperatorContrib`.
    enum Status {
        // Contract is initialised w/ no contributions. Call `contributeFunds`
        // to transition into `OpenForPublicContrib`
        WaitForOperatorContrib,

        // Contract has been initially funded by operator. Public and reserved
        // contributors can now call `contributeFunds`. When the contract is
        // collaterialised with exactly the staking requirement, the contract
        // transitions into `WaitForFinalized` state.
        OpenForPublicContrib,

        // Operator must invoke `finalizeNode` to transfer the tokens and the
        // node registration details to the `stakingRewardsContract` to
        // transition to `Finalized` state.
        WaitForFinalized,

        // Contract interactions are blocked until `reset` is called.
        Finalized
    }

    struct ReservedContribution {
        uint256 amount;   // Amount that is reserved
        bool    received; // Records if the contributor has sent money to the contribution contract
    }

    //////////////////////////////////////////////////////////////
    //                                                          //
    //                       Events                             //
    //                                                          //
    //////////////////////////////////////////////////////////////

    event Finalized                (uint256 indexed serviceNodePubkey);
    event NewContribution          (address indexed contributor, uint256 amount);
    event OpenForPublicContribution(uint256 indexed serviceNodePubkey, address indexed operator, uint16 fee);
    event Filled                   (uint256 indexed serviceNodePubkey, address indexed operator);
    event WithdrawContribution     (address indexed contributor, uint256 amount);
    event UpdateStakerBeneficiary  (address indexed staker, address oldBeneficiary, address newBeneficiary);

    //////////////////////////////////////////////////////////////
    //                                                          //
    //                     Variables                            //
    //                                                          //
    //////////////////////////////////////////////////////////////

    function SESH()                                  external view returns (IERC20);
    function stakingRewardsContract()                external view returns (IServiceNodeRewards);
    function stakingRequirement()                    external view returns (uint256);

    function blsPubkey()                             external view returns (uint256, uint256);
    function serviceNodeParams()                     external view returns (IServiceNodeRewards.ServiceNodeParams memory);
    function blsSignature()                          external view returns (IServiceNodeRewards.BLSSignatureParams memory);

    function operator()                              external view returns (address);
    function contributions(address)                  external view returns (uint256);
    function contributionTimestamp(address)          external view returns (uint256);
    function contributorAddresses(uint256)           external view returns (IServiceNodeRewards.Staker memory);
    function maxContributors()                       external view returns (uint256);

    function reservedContributions(address)          external view returns (uint256, bool);
    function reservedContributionsAddresses(uint256) external view returns (address);

    function status()                                external view returns (Status);
    function manualFinalize()                        external view returns (bool);

    //////////////////////////////////////////////////////////////
    //                                                          //
    //                       Errors                             //
    //                                                          //
    //////////////////////////////////////////////////////////////

    error CalcMinContributionGivenBadContribArgs  (uint256 numContributors, uint256 maxNumContributors);
    /// @notice Contract is not in a state where it can accept contributions
    error ContributeFundsNotPossible              (Status status);
    error ContributionBelowMinAmount              (uint256 contributed, uint256 min);
    error ContributionBelowReservedAmount         (uint256 contributed, uint256 reserved);
    error ContributionExceedsStakingRequirement   (uint256 totalContributed, uint256 totalReserved, uint256 stakingRequirement);
    error DuplicateAddressInReservedContributor   (uint256 index);
    error FeeExceedsPossibleValue                 (uint16 fee, uint16 max);
    error FeeUpdateNotPossible                    (Status status);
    error FinalizeNotPossible                     (Status status);
    error FirstContributionMustBeOperator         (address contributor, address operator);
    error BeneficiaryUpdatingDisabledNodeIsNotOpen(uint256 ed25519Pubkey);

    /// @notice A wallet has attempted to contribute to the contract
    /// before the operator's wallet has contributed.
    error FirstReservedContributorMustBeOperator       (uint256 index, address operator);

    /// @notice A wallet has attempted an operation only permitted by the
    /// operator
    error OnlyOperatorIsAuthorised                     (address addr, address operator);
    error MaxContributorsExceeded                      (uint256 maxContributors);
    error PubkeyUpdateNotPossible                      (Status status);
    error RescueBalanceIsEmpty                         (address token);
    error RescueNotPossible                            (Status status);
    error ReservedContributorHasZeroAddress            (uint256 index);
    error ReservedContributorUpdateNotPossible         (Status status);
    error ReservedContributionBelowMinAmount           (uint256 index, uint256 contributed, uint256 min);
    error ReservedContributionExceedsStakingRequirement(uint256 index, uint256 contributed, uint256 remaining);

    /// @notice The rewards contract max contributor value has changed and no
    /// longer matches this contract's max contributor value invalidating the
    /// contract.
    ///
    /// The operator or contributors should withdraw their funds and the operator
    /// should deploy another contribution contract to attain a new contract with
    /// the correct values.
    error RewardsContractMaxContributorsChanged        (uint256 oldMax, uint256 newMax);

    /// @notice The staking requirement has changed on the rewards contract and
    /// no longer matches this contract's staking requirement.
    ///
    /// See `RewardsContractMaxContributorsChanged` for more info.
    error RewardsContractStakingRequirementChanged     (uint256 oldRequirement, uint256 newRequirement);

    /// @notice Updating of beneficiary failed because the wallet that requested
    /// it `nonContributorAddr` is not a contributor for this node.
    error NonContributorUpdatedBeneficiary             (address nonContributorAddr);
    error TooManyReservedContributors                  (uint256 length, uint256 max);
    error WithdrawTooEarly                             (uint256 contribTime, uint256 blockTime, uint256 delayRequired);

    //////////////////////////////////////////////////////////////
    //                                                          //
    //                  State-changing functions                //
    //                                                          //
    //////////////////////////////////////////////////////////////

    /// @notice Update the flag that allows or disallows the contract from
    /// automatically finalizing the contract when the staking requirement is met.
    ///
    /// This can be called at any point of the contract's lifetime.
    function updateManualFinalize(bool value) external;

    /// @notice Update the node fee held in this contract.
    ///
    /// This can only be called prior to the operator contributing funds to the
    /// contract or alternatively after they have called `reset`.
    function updateFee(uint16 fee) external;

    /// @notice Update the public keys and their proofs held in the contract.
    ///
    /// This can only be called prior to the operator contributing funds to the
    /// contract or alternatively after they have called `reset`.
    ///
    /// @param newBLSPubkey The new 64 byte BLS public key for the node.
    /// @param newBLSSig The new 128 byte BLS proof-of-posession signature that proves
    /// the caller knows the secret component of `key`.
    /// @param ed25519Pubkey The new 32 byte Ed25519 public key for the node.
    /// @param ed25519Sig0 First 32 byte component of the signature for the Ed25519 key.
    /// @param ed25519Sig1 Second 32 byte component of the signature for the Ed25519 key.
    function updatePubkeys(BN256G1.G1Point memory newBLSPubkey,
                           IServiceNodeRewards.BLSSignatureParams memory newBLSSig,
                           uint256 ed25519Pubkey,
                           uint256 ed25519Sig0,
                           uint256 ed25519Sig1) external;

    /// @notice Update the reservation slots for contributors held in this contract.
    ///
    /// This can only be called prior to the operator contributing funds to the
    /// contract or alternatively after they have called `reset`.
    ///
    /// The list of reservations can be empty which will reset the contract,
    /// deleting any reservation data that is currently held. The list cannot
    /// specify more reservations than `maxContributors` or otherwise the
    /// function reverts.
    ///
    /// @param reserved The new array of reserved contributors with their
    /// proportion of stake they must fulfill in the node.
    function updateReservedContributors(IServiceNodeRewards.ReservedContributor[] memory reserved) external;

    /// @notice Update the beneficiary for the wallet/contributor that invokes
    /// this call.
    ///
    /// If the caller is not a contributor in this contract, the contract
    /// reverts.
    function updateBeneficiary(address newBeneficiary) external;

    /// @notice Contribute funds to the contract for the node run by
    /// `operator`. The `amount` of SESH token must be at least the
    /// `minimumContribution` or their amount specified in their reserved
    /// contribution (if applicable) otherwise the contribution is reverted.
    ///
    /// Node registration parameters must be assigned prior to the operator
    /// contribution or alternatively after `reset` is invoked.
    ///
    /// The operator must contribute their minimum contribution/reservation
    /// before the public or reserved contributors can contribute to the node.
    /// The minimum an operator can contribute is 25% of the staking requirement
    /// regardless of having a reservation or not.
    ///
    /// @param amount The amount of SESH token to contribute to the contract.
    /// @param beneficiary Optionally specify a beneficiary where rewards will
    /// be paid out to. You may set this to `address(0)` to omit this field and
    /// use the default behaviour which does one of two things,
    ///
    ///   1. If the contributor has not assigned a beneficiary yet, it assigns
    ///   the current interacting wallet as the beneficiary (e.g. The rewards
    ///   are paid to the staking wallet).
    ///
    ///   2. If the contributor has already assigned a beneficiary, the
    ///   beneficiary for the contributor remains unchanged.
    function contributeFunds(uint256 amount, address beneficiary) external;

    /// @notice Activate the node by transferring the registration details and
    /// tokens to the `stakingRewardsContract`.
    ///
    /// After finalisation the contract can be reused by invoking `reset`.
    function finalize() external;

    /// @notice Reset the contract allowing it to be reused to re-register the
    /// pre-existing node by refunding and removing all stored contributions.
    ///
    /// This function can be called any point in the lifetime of the contract to
    /// bring it to its initial state. Node parameters (Ed25519 key, sig, fee)
    /// and the BLS key and signature are preserved across reset and can be
    /// updated piecemeal via the `update...` family of functions.
    function reset() external;

    /// @notice Helper function that invokes a reset and updates all possible
    /// parameters for the registration.
    ///
    /// This function is equivalent to calling in sequence:
    ///
    ///   - `reset`
    ///   - `updatePubkeys`
    ///   - `updateFee`
    ///   - `updateReservedContributors`
    ///   - `updateManualFinalize`
    ///   - `contributeFunds`
    ///
    /// If reserved contributors are not desired, an empty array is accepted.
    ///
    /// If the operator wishes to withhold their initial contribution, a `0`
    /// amount is accepted. When a `0` amount is specified, `beneficiary` is
    /// also ignored.
    function resetUpdateAndContribute(BN256G1.G1Point memory key,
                                      IServiceNodeRewards.BLSSignatureParams memory sig,
                                      IServiceNodeRewards.ServiceNodeParams memory params,
                                      IServiceNodeRewards.ReservedContributor[] memory reserved,
                                      bool _manualFinalize,
                                      address beneficiary,
                                      uint256 amount) external;


    /// @notice Function to allow owner to rescue any ERC20 tokens sent to the
    /// contract after it has been finalized.
    ///
    /// @dev Rescue is only allowed when finalized or no contribution has been
    /// made to the contract so any token balance from contributors are either
    /// absent or have been transferred to the `stakingRewardsContract` and the
    /// remaining tokens can be sent without risking contributor collateral.
    ///
    /// @param tokenAddress The ERC20 token to rescue from the contract.
    function rescueERC20(address tokenAddress) external;

    /// @notice Allows the contributor or operator to withdraw their contribution
    /// from the contract.
    ///
    /// After finalization, the registration is transferred to the
    /// `stakingRewardsContract` and withdrawal by or the operator contributors
    /// must be done through that contract.
    function withdrawContribution() external;

    //////////////////////////////////////////////////////////////
    //                                                          //
    //                Non-state-changing functions              //
    //                                                          //
    //////////////////////////////////////////////////////////////

    /// @notice Calculates the minimum contribution amount given the current
    /// contribution status of the contract.
    ///
    /// @dev The minimum contribution is dynamically calculated based on the
    /// number of contributors and the staking requirement. It returns
    /// math.ceilDiv of the calculation
    ///
    /// @return result The minimum contribution amount.
    function minimumContribution() external view returns (uint256 result);

    /// @notice Function to calculate the minimum contribution given the staking
    /// parameters.
    ///
    /// This function reverts if invalid parameters are given such that the
    /// operations would wrap or divide by 0.
    ///
    /// @param contributionRemaining The amount of contribution still available
    /// to be contributed to this contract.
    /// @param numContributors The number of contributors that have contributed
    /// to the contract already including the operator.
    /// @param maxNumContributors The maximum number of contributors allowed to
    /// contribute to this contract.
    function calcMinimumContribution(
        uint256 contributionRemaining,
        uint256 numContributors,
        uint256 maxNumContributors
    ) external pure returns (uint256 result);

    /// @notice Calculates the minimum operator contribution given the staking
    /// requirement.
    function minimumOperatorContribution(uint256 _stakingRequirement) external pure returns (uint256 result);

    /// @dev This function allows unit-tests to query the length without having
    /// to know the storage slot of the array size.
    function contributorAddressesLength() external view returns (uint256 result);

    /// @notice Get the contribution by the operator, defined to always be the
    /// first contribution in the contract.
    function operatorContribution() external view returns (uint256 result);

    /// @notice Access the list of contributor addresses and corresponding contributions.  The
    /// first returned address (if any) is also the operator address.
    function getContributions() external view returns (address[] memory addrs, address[] memory beneficiaries, uint256[] memory contribs);

    /// @notice Access the list of reserved addresses and corresponding
    /// contributions. The first returned address (if any) is also the operator
    /// address.
    function getReserved() external view returns (address[] memory addrs, uint256[] memory contribs, bool[] memory received);

    /// @notice Sum up all the contributions recorded in the contributors list
    function totalContribution() external view returns (uint256 result);

    /// @notice Sum up all the reserved contributions recorded in the reserved list
    function totalReservedContribution() external view returns (uint256 result);
}
