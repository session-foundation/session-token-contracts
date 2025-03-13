// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.26;

import "../ServiceNodeContribution.sol";
import "./MockERC20.sol";
import "./MockServiceNodeRewards.sol";

// NOTE: We conduct assertion based testing for the service node contribution
// contract in Echidna. When we use property based-testing, the sender of the
// transactions to `ServiceNodeContribution.sol` is limited to this contract's
// address.
//
// However, `ServiceNodeContribution` is a contract that wants to be tested by
// taking in arbitrary contributions from different wallets. This is possible in
// `assertion` mode instead of `property` mode. This means that tests have to
// enforce invariants using `assert` instead of returning bools.
//
// We've left the `property` based testing in the contract but instead used them
// with asserts to test arbitrary invariants at any point in the contract.

// NOTE: If you suddenly trigger an assertion due to some faulty changes,
// echidna reports a very unhelpful message when it tries to deploy the contract
// to the devnet with:
//
// ```
// echidna: Deploying the contract 0x00a329c0648769A73afAc7F9381E08FB43dBEA72 failed (revert, out-of-gas, sending ether to an non-payable constructor, etc.):
// error Revert 0x
// ```
//
// To debug this I recommend commenting out asserts one at a time to isolate
// the assertion that is failing.
//
// I've noticed that there's a bug somewhere in Echidna itself where it refuses
// to deploy a contract even though no assertions are triggered. However
// shuffling code around, or, evaluating the assert in a different way
// "suddenly" gets it to deploy. Very frustrating, there's no way to console.log
// from echidna yet where I can double check this.

contract ServiceNodeContributionEchidnaTest {
    // TODO: Staking requirement is currently hard-coded to value in script/deploy-local-test.js
    // TODO: Immutable variables in the testing contract causes Echidna 2.2.3 to crash
    uint256                                public constant STAKING_REQUIREMENT = 1e11;
    IERC20                                 public seshToken;
    MockServiceNodeRewards                 public snRewards;
    ServiceNodeContribution                public snContribution;
    IServiceNodeRewards.ServiceNodeParams  public snParams;
    address                                public snOperator;
    BN256G1.G1Point                        public blsPubkey;
    IServiceNodeRewards.BLSSignatureParams public blsSig;

    constructor() {
        snOperator = msg.sender;
        seshToken = new MockERC20("Session Token", "SESH", 9);
        snRewards = new MockServiceNodeRewards(address(seshToken), STAKING_REQUIREMENT);

        snParams.serviceNodePubkey = 1;
        snParams.serviceNodeSignature1 = 2;
        snParams.serviceNodeSignature2 = 3;
        snParams.fee = 4;

        blsPubkey.X = 5;
        blsPubkey.Y = 6;

        IServiceNodeRewards.BLSSignatureParams memory sig;
        sig.sigs0 = 0;
        sig.sigs1 = 1;
        sig.sigs2 = 2;
        sig.sigs3 = 3;

        IServiceNodeRewards.ReservedContributor[] memory reserved = new IServiceNodeRewards.ReservedContributor[](0);
        snContribution = new ServiceNodeContribution(
            /*snRewards*/         address(snRewards),
            /*maxContributors*/   snRewards.maxContributors(),
            /*key*/               blsPubkey,
            /*sig*/               blsSig,
            /*serviceNodeParams*/ snParams,
            /*reserved*/          reserved,
            /*operator*/          snOperator,
            /*manualFinalize*/    false
        );

        assert(snContribution.maxContributors() == snRewards.maxContributors());
    }

    function mintTokensForTesting() internal {
        if (seshToken.allowance(msg.sender, address(snRewards)) <= 0) {
            assert(seshToken.transferFrom(address(0), msg.sender, type(uint64).max));
            seshToken.approve(address(snContribution), type(uint64).max);
        }
    }

    //////////////////////////////////////////////////////////////
    //                                                          //
    //                  Property Testing                        //
    //                                                          //
    //////////////////////////////////////////////////////////////
    function echidna_prop_max_contributor_limit() public view returns (bool) {
        bool result = snContribution.contributorAddressesLength() <= snContribution.maxContributors();
        assert(result);
        return result;
    }

    function echidna_prop_total_contribution_is_staking_requirement() public view returns (bool) {
        bool result = true;
        uint256 total = snContribution.totalContribution();
        if (snContribution.status() == IServiceNodeContribution.Status.Finalized) {
            result = total == STAKING_REQUIREMENT;
        } else {
            result = total <= STAKING_REQUIREMENT;
        }
        assert(result);
        return result;
    }

    function echidna_prop_operator_has_contribution() public view returns (bool) {
        bool result = snContribution.totalContribution() > 0
            ? (snContribution.contributions(snContribution.operator()) > 0)
            : (snContribution.contributions(snContribution.operator()) == 0);
        assert(result);
        return result;
    }

    function echidna_prop_check_immutable_props() public view returns (bool) {
        IServiceNodeRewards.ServiceNodeParams memory params = snContribution.serviceNodeParams();
        bool snParamsLockedIn = (snParams.serviceNodePubkey == params.serviceNodePubkey) &&
            (snParams.serviceNodeSignature1 == params.serviceNodeSignature1) &&
            (snParams.serviceNodeSignature2 == params.serviceNodeSignature2) &&
            (snParams.fee == params.fee);
        assert(snParamsLockedIn);

        (uint256 blsPKeyX, uint256 blsPKeyY) = snContribution.blsPubkey();

        bool result = address(snRewards) == address(snContribution.stakingRewardsContract()) &&
            STAKING_REQUIREMENT == snContribution.stakingRequirement() &&
            snRewards.maxContributors() == snContribution.maxContributors() &&
            snOperator == snContribution.operator() &&
            seshToken == snContribution.stakingRewardsContract().designatedToken() &&
            blsPubkey.X == blsPKeyX &&
            blsPubkey.Y == blsPKeyY &&
            snParamsLockedIn;
        assert(result);
        return result;
    }

    //////////////////////////////////////////////////////////////
    //                                                          //
    //                  Contract Wrapper                        //
    //                                                          //
    //////////////////////////////////////////////////////////////
    function testContributeOperatorFunds(
        uint256 _amount
    ) public {
        mintTokensForTesting();
        address defaultBeneficiary = address(0);

        if (
            snOperator == msg.sender &&
            snContribution.operatorContribution() == 0 &&
            _amount >= snContribution.minimumContribution()
        ) {
            uint256 balanceBeforeContribute = seshToken.balanceOf(msg.sender);

            assert(snContribution.contributions(snContribution.operator()) == 0);
            assert(snContribution.operatorContribution() == 0);
            assert(snContribution.totalContribution() == 0);
            assert(snContribution.contributorAddressesLength() == 0);

            try snContribution.contributeFunds(_amount, defaultBeneficiary) {} catch {
                assert(false); // Contribute must succeed as all necessary preconditions are met
            }

            assert(snContribution.contributions(snContribution.operator()) >= snContribution.minimumContribution());
            assert(snContribution.operatorContribution() >= snContribution.minimumContribution());
            assert(snContribution.totalContribution() >= snContribution.minimumContribution());
            assert(snContribution.contributorAddressesLength() == 1);

            assert(seshToken.balanceOf(msg.sender) == balanceBeforeContribute - _amount);
        } else {
            try snContribution.contributeFunds(_amount, defaultBeneficiary) {
                assert(false); // Contribute as operator must not succeed
            } catch {}
        }
    }

    function testContributeFunds(uint256 amount) public {
        mintTokensForTesting();
        uint256 balanceBeforeContribute = seshToken.balanceOf(msg.sender);
        address defaultBeneficiary = address(0);

        if (snContribution.totalContribution() < STAKING_REQUIREMENT) {
            try snContribution.contributeFunds(amount, defaultBeneficiary) {} catch {
                assert(false); // Contribute must not fail as we have tokens and are under the staking requirement
            }
        } else {
            try snContribution.contributeFunds(amount, defaultBeneficiary) {
                assert(false); // Contribute must not succeed as we have hit the staking requirement
            } catch {}
        }
        assert(snContribution.contributorAddressesLength() < snContribution.maxContributors());
        assert(snContribution.totalContribution() <= STAKING_REQUIREMENT);

        assert(seshToken.balanceOf(msg.sender) == balanceBeforeContribute - amount);

        if (snContribution.totalContribution() == STAKING_REQUIREMENT) {
            assert(snContribution.status() == IServiceNodeContribution.Status.Finalized);
            assert(seshToken.balanceOf(address(snContribution)) == 0);
        }
    }

    function testWithdrawContribution() public {
        uint256 contribution = snContribution.contributions(msg.sender);
        uint256 balanceBeforeWithdraw = seshToken.balanceOf(msg.sender);
        uint256 numberContributorsBefore = snContribution.contributorAddressesLength();

        try snContribution.withdrawContribution() {
            // Withdraw can succeed if we are not the operator and we had
            // contributed to the contract
            if (snOperator == msg.sender) {
                assert(snContribution.contributorAddressesLength() == 0);
            } else {
                assert(snContribution.contributorAddressesLength() == (numberContributorsBefore - 1));
                assert(block.timestamp >= snContribution.WITHDRAWAL_DELAY());
            }
            assert(contribution > 0);
        } catch {
            assert(numberContributorsBefore == 0);
            assert(contribution == 0);
            assert(block.timestamp < snContribution.WITHDRAWAL_DELAY());
        }

        assert(snContribution.status() != IServiceNodeContribution.Status.Finalized);
        assert(snContribution.operatorContribution() <= STAKING_REQUIREMENT);
        assert(snContribution.totalContribution() <= STAKING_REQUIREMENT);

        assert(seshToken.balanceOf(msg.sender) == balanceBeforeWithdraw + contribution);
    }

    function testReset() public {
        if (msg.sender == snOperator) {
            try snContribution.reset() {} catch {
                assert(false); // Can reset if finalized
            }
            assert(snContribution.status() == IServiceNodeContribution.Status.WaitForOperatorContrib);
            assert(snContribution.contributions(msg.sender) == 0);
            assert(snContribution.operatorContribution() == 0);
        } else {
            try snContribution.reset() {
                assert(false); // Can not reset
            } catch {}
        }
    }

    function testRescueERC20(uint256 amount) public {
        if (msg.sender == snOperator &&
            (snContribution.status() == IServiceNodeContribution.Status.WaitForOperatorContrib ||
             snContribution.status() == IServiceNodeContribution.Status.Finalized)) {
            bool fundTheContract = (amount % 2 == 0); // NOTE: 50% chance of funding
            if (fundTheContract) assert(seshToken.transferFrom(address(0), address(snContribution), amount));

            if (fundTheContract) {
                try snContribution.rescueERC20(address(seshToken)) {} catch {
                    assert(false); // Rescue should be allowed because we just funded the contract
                }
            } else {
                try snContribution.rescueERC20(address(seshToken)) {
                    assert(false); // Can't rescue because contract was not funded
                } catch {}
            }
        } else {
            try snContribution.rescueERC20(address(seshToken)) {
                assert(false); // Contract is not finalized or it is cancelled so we can't rescue
            } catch {}
        }
    }

    function testMinimumContribution() public view returns (uint256) {
        uint256 result = snContribution.minimumContribution();
        assert(result <= STAKING_REQUIREMENT);
        return result;
    }

    /*
     * @notice Fuzz all branches of `calcMinContribution`
     */
    function testCalcMinimumContribution(
        uint256 contributionRemaining,
        uint256 numContributors,
        uint256 maxNumContributors
    ) public view {
        if ((maxNumContributors > numContributors) && (contributionRemaining > 0)) {
            uint256 result = snContribution.calcMinimumContribution(
                contributionRemaining,
                numContributors,
                maxNumContributors
            );
            assert(result <= contributionRemaining);
        } else {
            try snContribution.calcMinimumContribution(contributionRemaining, numContributors, maxNumContributors) {
                assert(false); // All contributors used up, the minimum contribution should revert
            } catch {}
        }
    }
}
