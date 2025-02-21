// SPDX-License-Identifier: MIT

pragma solidity ^0.8.26;

import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "../interfaces/IServiceNodeRewards.sol";
import "../interfaces/IServiceNodeContributionFactory.sol";
import "../interfaces/IServiceNodeContribution.sol";

interface ITokenVestingStaking {

    //////////////////////////////////////////////////////////////
    //                                                          //
    //                       Events                             //
    //                                                          //
    //////////////////////////////////////////////////////////////

    event TokensReleased        (IERC20 indexed token, uint256 amount);
    event TokensRevokedReleased (IERC20 indexed token, uint256 amount);
    event TokenVestingRevoked   (IERC20 indexed token);
    event BeneficiaryTransferred(address oldBeneficiary, address newBeneficiary);
    event RevokerTransferred    (address oldRevoker, address newRevoker);

    //////////////////////////////////////////////////////////////
    //                                                          //
    //                     Variables                            //
    //                                                          //
    //////////////////////////////////////////////////////////////

    /// @notice Address configured to receive tokens after they've vested from
    /// the contract. The beneficiary is transferable if the contract was
    /// deployed with the `transferableBeneficiary` enabled.
    function beneficiary() external view returns (address);

    /// @notice Indicates if the beneficiary is transferable to a new address or
    /// not.
    function transferableBeneficiary() external view returns (bool);

    /// @notice Start time of the contract's vesting period denoted as a unix
    /// timestamp
    function start() external view returns (uint256);

    /// @notice End time of the contract's vesting period denoted as a unix
    /// timestamp
    function end() external view returns (uint256);

    /// @notice The token that the contract is vesting to the investor.
    function SESH() external view returns (IERC20);

    /// @notice The contract that accepts investor tokens for staking
    function rewardsContract() external view returns (IServiceNodeRewards);

    /// @notice The contract that deploys multi-contributor contracts that the
    /// investor can stake to.
    function snContribFactory() external view returns (IServiceNodeContributionFactory);

    /// @notice Address that has permissions to halt the vesting process and
    /// withdraw the tokens. The revoker also has permissions to access admin
    /// functions of the contract.
    function revoker() external view returns (address);

    //////////////////////////////////////////////////////////////
    //                                                          //
    //                  State-changing functions                //
    //                                                          //
    //////////////////////////////////////////////////////////////

    //////////////////////////////////////////////////////////////
    //                                                          //
    //                 Rewards contract functions               //
    //                                                          //
    //////////////////////////////////////////////////////////////

    /// @notice Adds a BLS public key to the list of service nodes. Requires
    /// a proof of possession BLS signature to prove user controls the public
    /// key being added.
    ///
    /// @param blsPubkey 64 byte BLS public key for the service node.
    /// @param blsSignature 128 byte BLS proof of possession signature that
    /// proves ownership of the `blsPubkey`.
    /// @param serviceNodeParams The service node to add including the ed25519
    /// public key and signature that proves ownership of the private component
    /// of the public key and the desired fee the operator is charging.
    /// @param snBeneficiary Address that should receive the staking rewards
    /// This address may not be set to the zero address `address(0)`.
    function addBLSPublicKey(
        BN256G1.G1Point calldata blsPubkey,
        IServiceNodeRewards.BLSSignatureParams calldata blsSignature,
        IServiceNodeRewards.ServiceNodeParams calldata serviceNodeParams,
        address snBeneficiary
    ) external;

    /// @notice Initiates a request for the service node to leave the network by
    /// their service node ID.
    ///
    /// @param serviceNodeID The ID of the service node to be removed.
    function initiateExitBLSPublicKey(uint64 serviceNodeID) external;

    /// @notice Retrieves the unlocked balance from exited/deregistered nodes
    /// back into this investor's contract.
    function claimRewards() external;

    /// @notice Claim a specific amount of unlocked balance from
    /// exited/deregistered nodes back into this investor's contract.
    function claimRewards(uint256 amount) external;

    //////////////////////////////////////////////////////////////
    //                                                          //
    //         Multi-contributor SN contract functions          //
    //                                                          //
    //////////////////////////////////////////////////////////////

    /// @notice Contribute funds to the specified multi-contribution contract.
    ///
    /// @param snContribAddr Address of the multi-contributor contract to
    /// update. Reverts if the contract was not deployed by the factory assigned
    /// to this contract.
    /// @param snContribBeneficiary Specify the address that will receive the
    /// rewards. This address may be set to `address(0)` to use the default
    /// behaviour. See `contributeFunds` in `IServiceNodeContribution`
    function contributeFunds(address snContribAddr,
                             uint256 amount,
                             address snContribBeneficiary) external;

    /// @notice Withdraw the contribution that has been made prior to a
    /// multi-contributor contract in `contributeFunds` returning the funds
    /// back to this investor's contract.
    ///
    /// This is only valid if the multi-contribution contract has not finalised
    /// yet or has already been reset.
    ///
    /// - If it has been finalised the funds have been transferred to the
    ///   rewards contract in which they must exit the node to reclaim their
    ///   funds back to the investor's contract.
    ///
    /// - If the contract has been reset the funds have been returned back to
    ///   this contract already.
    ///
    /// @param snContribAddr Address of the multi-contributor contract to
    /// update. Reverts if the contract was not deployed by the factory assigned
    /// to this contract.
    function withdrawContribution(address snContribAddr) external;

    /// @notice Assign a new beneficiary for a multi-contributor contract that
    /// this contract has contributed to prior.
    /// @param snContribAddr Address of the multi-contributor contract to
    /// update. Reverts if the contract was not deployed by the factory assigned
    /// to this contract.
    /// @param snContribBeneficiary Specify the address that will receive the
    /// rewards. See notes on `snContribBeneficiary` for `contributeFunds`.
    function updateBeneficiary(address snContribAddr, address snContribBeneficiary) external;

    //////////////////////////////////////////////////////////////
    //                                                          //
    //             Investor contract functions                  //
    //                                                          //
    //////////////////////////////////////////////////////////////

    /// @notice Transfers vested tokens to beneficiary.
    /// @param token ERC20 token which is being vested.
    function release(IERC20 token) external;

    /// @notice Revoke the vesting contract and return funds to the revoker.
    /// This can be called multiple times by revoker to retrieve any additional
    /// tokens that are sent to the contract after revocation.
    ///
    /// On the first revocation, `TokenVestingRevoked` is emit and omitted for
    /// subsequent calls.
    ///
    /// @param token ERC20 token to retrieve the balance for
    function revoke(IERC20 token) external;

    /// @notice Changes the beneficiary for the contract. Only permitted if
    /// `transferableBeneficiary` is set.
    function transferBeneficiary(address beneficiary_) external;

    /// @notice Change the revoker for the contract
    function transferRevoker(address revoker_) external;

}
