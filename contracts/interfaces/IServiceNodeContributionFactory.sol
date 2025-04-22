// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.26;

import "./IServiceNodeRewards.sol";

interface IServiceNodeContributionFactory {
    function stakingRewardsContract()   external view returns (IServiceNodeRewards);
    function deployedContracts(address) external view returns (bool);

    function deploy(BN256G1.G1Point calldata key,
                    IServiceNodeRewards.BLSSignatureParams calldata sig,
                    IServiceNodeRewards.ServiceNodeParams calldata params,
                    IServiceNodeRewards.ReservedContributor[] calldata reserved,
                    bool manualFinalize) external returns (address result);

    function owns(address contractAddress) external view returns (bool);
}
