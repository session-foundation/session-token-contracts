// SPDX-License-Identifier: MIT

pragma solidity ^0.8.26;

import "../libraries/Shared.sol";
import "../interfaces/ITokenVestingStaking.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @notice A token holder contract that vests its ERC20 token to the
/// beneficiary. All tokens are locked until the end of the contract where the
/// balance is released. All tokens can be staked to solo and multi-contribution
/// nodes during the vesting period from this contract's balance.
///
/// If the contract is revoked, all funds are transferred to the revoker and the
/// contract is halted. Staked funds at revocation can be retrieved by the
/// revoker upon unstaking.
///
/// The vesting schedule is time-based (i.e. using block timestamps as opposed
/// to e.g. block numbers) and is therefore sensitive to timestamp manipulation
/// (which is something miners can do, to a certain degree). Therefore, it is
/// recommended to avoid using short time durations (less than a minute).
///
/// See `ITokenVestingStaking` for public API documentation.
contract TokenVestingStaking is ITokenVestingStaking, Shared {

    using SafeERC20 for IERC20;

    //////////////////////////////////////////////////////////////
    //                                                          //
    //                      Modifiers                           //
    //                                                          //
    //////////////////////////////////////////////////////////////

    modifier onlyBeneficiary() {
        require(msg.sender == beneficiary, "Vesting: Caller must be beneficiary");
        _;
    }

    modifier onlyRevoker() {
        require(msg.sender == revoker, "Vesting: Caller must be revoker");
        _;
    }

    modifier onlyRevokerIfRevokedElseBeneficiary() {
        if (revoked)
            require(msg.sender == revoker, "Vesting: Caller must be revoker");
        else
            require(msg.sender == beneficiary, "Vesting: Caller must be beneficiary");
        _;
    }

    modifier notRevoked() {
        require(!revoked, "Vesting: token revoked");
        _;
    }

    modifier afterStart() {
        require(block.timestamp >= start, "Vesting: not started");
        _;
    }

    //////////////////////////////////////////////////////////////
    //                                                          //
    //                     Variables                            //
    //                                                          //
    //////////////////////////////////////////////////////////////

    // Vesting
    address                         public           beneficiary;
    address                         public           revoker;
    bool                            public immutable transferableBeneficiary;
    uint256                         public immutable start;
    uint256                         public immutable end;
    bool                            public           revoked;

    // Contracts
    // solhint-disable-next-line var-name-mixedcase
    IERC20                          public immutable SESH;
    IServiceNodeRewards             public immutable rewardsContract;
    IServiceNodeContributionFactory public immutable snContribFactory;

    //////////////////////////////////////////////////////////////
    //                                                          //
    //                  State-changing functions                //
    //                                                          //
    //////////////////////////////////////////////////////////////

    /// @param beneficiary_ Address of the beneficiary to whom vested tokens
    /// are transferred
    /// @param revoker_ The person with the power to revoke the vesting.
    /// Setting the zero address means it is not revocable.
    /// @param start_ The unix time when the beneficiary can start staking the
    /// tokens.
    /// @param end_ The unix time of the end of the vesting period, everything
    /// withdrawable after
    /// @param transferableBeneficiary_ Whether the beneficiary address can be
    /// transferred
    /// @param rewardsContract_ The SESH staking rewards contract that can
    /// be interacted with
    /// @param sesh_ The SESH token address.
    constructor(
        address beneficiary_,
        address revoker_,
        uint256 start_,
        uint256 end_,
        bool transferableBeneficiary_,
        IServiceNodeRewards rewardsContract_,
        IServiceNodeContributionFactory snContribFactory_,
        IERC20 sesh_
    ) nzAddr(beneficiary_) nzAddr(address(rewardsContract_)) nzAddr(address(sesh_)) {
        require(start_ <= end_, "Vesting: start_ after end_");
        require(block.timestamp < start_, "Vesting: start before current time");

        beneficiary             = beneficiary_;
        revoker                 = revoker_;
        start                   = start_;
        end                     = end_;
        transferableBeneficiary = transferableBeneficiary_;
        rewardsContract         = rewardsContract_;
        snContribFactory        = snContribFactory_;
        SESH                    = sesh_;
    }

    //////////////////////////////////////////////////////////////
    //                                                          //
    //                 Rewards contract functions               //
    //                                                          //
    //////////////////////////////////////////////////////////////

    function addBLSPublicKey(
        BN256G1.G1Point calldata blsPubkey,
        IServiceNodeRewards.BLSSignatureParams calldata blsSignature,
        IServiceNodeRewards.ServiceNodeParams calldata serviceNodeParams,
        address snBeneficiary
    ) external onlyRevokerIfRevokedElseBeneficiary afterStart nzAddr(snBeneficiary) {
        // NOTE: Configure custom beneficiary for investor
        uint256 stakingRequirement                            = rewardsContract.stakingRequirement();
        IServiceNodeRewards.Contributor[] memory contributors = new IServiceNodeRewards.Contributor[](1);
        contributors[0] = IServiceNodeRewards.Contributor(IServiceNodeRewards.Staker(/*addr*/ address(this),
                                                                                     /*beneficiary*/ snBeneficiary),
                                                                                     stakingRequirement);

        // NOTE: Allow staking requirement to be transferred
        SESH.approve(address(rewardsContract), stakingRequirement);

        // NOTE: Register node
        rewardsContract.addBLSPublicKey(blsPubkey, blsSignature, serviceNodeParams, contributors);
    }

    function initiateExitBLSPublicKey(uint64 serviceNodeID) external onlyRevokerIfRevokedElseBeneficiary afterStart {
        rewardsContract.initiateExitBLSPublicKey(serviceNodeID);
    }

    function claimRewards() external onlyRevokerIfRevokedElseBeneficiary afterStart {
        rewardsContract.claimRewards();
    }

    function claimRewards(uint256 amount) external onlyRevokerIfRevokedElseBeneficiary afterStart {
        rewardsContract.claimRewards(amount);
    }

    //////////////////////////////////////////////////////////////
    //                                                          //
    //         Multi-contributor SN contract functions          //
    //                                                          //
    //////////////////////////////////////////////////////////////

    function getContributionContract(address contractAddr) private view returns (IServiceNodeContribution result) {
        // NOTE: Retrieve contract
        bool contractDeployed = snContribFactory.owns(contractAddr);
        result                = IServiceNodeContribution(contractAddr);
        require(contractDeployed, "Contract address is not a valid multi-contributor SN contract");
    }

    function contributeFunds(address snContribAddr,
                             uint256 amount,
                             address snContribBeneficiary
    ) external onlyRevokerIfRevokedElseBeneficiary afterStart nzAddr(snContribBeneficiary) {
        // NOTE: Approve and contribute funds
        IServiceNodeContribution snContrib = getContributionContract(snContribAddr);
        SESH.approve(snContribAddr, amount);
        snContrib.contributeFunds(amount, snContribBeneficiary);
    }

    function withdrawContribution(address snContribAddr) external override onlyRevokerIfRevokedElseBeneficiary afterStart {
        IServiceNodeContribution snContrib = getContributionContract(snContribAddr);
        snContrib.withdrawContribution();
    }

    function updateBeneficiary(address snContribAddr,
                               address snContribBeneficiary
    ) external onlyRevokerIfRevokedElseBeneficiary afterStart nzAddr(snContribBeneficiary) {
        IServiceNodeContribution snContrib = getContributionContract(snContribAddr);
        snContrib.updateBeneficiary(snContribBeneficiary);
    }

    //////////////////////////////////////////////////////////////
    //                                                          //
    //             Investor contract functions                  //
    //                                                          //
    //////////////////////////////////////////////////////////////

    // @note Tokens are cliffed at the `end` time
    function releasableAmount(IERC20 token) private view returns (uint256) {
        return block.timestamp < end ? 0 : token.balanceOf(address(this));
    }

    function release(IERC20 token) external override onlyBeneficiary notRevoked {
        uint256 amount = releasableAmount(token);
        require(amount > 0, "Vesting: no tokens are due");
        emit TokensReleased(token, amount);
        token.safeTransfer(beneficiary, amount);
    }

    function revoke(IERC20 token) external override onlyRevoker {
        if (!revoked) { // Only allowed to revoke whilst in vesting period
            require(block.timestamp <= end, "Vesting: vesting expired");
            revoked = true;
            emit TokenVestingRevoked(token);
        }

        // NOTE: Revoker has to wait for vesting period as well for predictable
        // circ. supply
        uint256 amount = releasableAmount(token);
        if (amount > 0) {
            emit TokensRevokedReleased(token, amount);
            token.safeTransfer(revoker, amount);
        }
    }

    function transferBeneficiary(address beneficiary_) external override onlyBeneficiary nzAddr(beneficiary_) {
        require(transferableBeneficiary, "Vesting: beneficiary not transferable");
        emit BeneficiaryTransferred(beneficiary, beneficiary_);
        beneficiary = beneficiary_;
    }

    function transferRevoker(address revoker_) external override onlyRevoker nzAddr(revoker_) {
        emit RevokerTransferred(revoker, revoker_);
        revoker = revoker_;
    }
}
