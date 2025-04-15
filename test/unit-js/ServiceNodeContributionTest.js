const { expect } = require("chai");
const { ethers } = require("hardhat");
const {getContractEvent} = require("./util");

// NOTE: Constants
const STAKING_TEST_AMNT = 15000000000000
const TEST_AMNT         = 50000000000000

const SN_CONTRIB_Status_WaitForOperatorContrib = 0n;
const SN_CONTRIB_Status_OpenForPublicContrib   = 1n;
const SN_CONTRIB_Status_WaitForFinalized       = 2n;
const SN_CONTRIB_Status_Finalized              = 3n;

const BLS_NODES =
[
  {
    blsPubkey: {
      X: BigInt("0x28852e6bd8fc98305370c1636e35d3b1fe30cb5d79e5392b1238f18a1f60a1ed"),
      Y: BigInt("0x1d0a9ed200fc6762ce53b42d6c9173a11c233a8e41d634ec7014c00ebb5ed4b0"),
    },
    blsSig: {
      sigs0: BigInt("0x27ceb4fb24b0cb43c55af0ce2f6463e6d14ec1c7f9edbad7c00fbb31a38e3d53"),
      sigs1: BigInt("0x2386070cdd9a315241a8d351e2185addc042ad36aca524ad93a7862ac452b9a1"),
      sigs2: BigInt("0x2170a69f683f44baabf1c590e6c5863a0d30b84d50144cb2f8cc8cb105fad7e9"),
      sigs3: BigInt("0x0d9e3b16e83584504b5a597e98cfa76f9d7487878b6a03677beed56fe7a1ba39"),
    },
    snParams: {
      serviceNodePubkey: BigInt("0x3621a81c1ef05d48fc9be9dd590ab0869a70fa751e40d8fbebdb0d90e285dbd8"),
      serviceNodeSignature1: BigInt("0x9812e9d91f4e468c56f77fdbb6735b50c2c3590055efb38f26796a4630d4da42"),
      serviceNodeSignature2: BigInt("0x40779f125038351141f70f5e8d24cc1b70abcd466a28847551cc1496c13ae209"),
      fee: 0
    },
    contributors: [
      {
        addr: BigInt("0x66d801a70615979d82c304b7db374d11c232db66"),
        stakedAmount: STAKING_TEST_AMNT,
      }
    ],
    reserved: [
    ]
  },
  {
    blsPubkey: {
      X: BigInt("0x137e85cd37748f14247358e0e44612210aa5fa27a8fbf28ad340c55767f15d2c"),
      Y: BigInt("0x18edb0ca60f8acb2632f940b18ac6ca4600f10f2b266c9d6c5e20124ede3bb8b"),
    },
    blsSig: {
      sigs0: BigInt("0x1d041dfbf3d6c94c4d171f53faae08fdf1124d9a4286e5d54dcc243e88a96a4f"),
      sigs1: BigInt("0x161c04dbf785039cdf5fea0f78a5b481f4daa7049b39a5fdec0a6e735ff09775"),
      sigs2: BigInt("0x26337d0059f0df7311a968162a7c2951aaa3bfc22213f88167ca06777d8f6469"),
      sigs3: BigInt("0x13149ba06fd741964f0068e4691b20417d221d9742ded83ab1db5d2ecb5129d5"),
    },
    snParams: {
      serviceNodePubkey: BigInt("0x60a9ab78cf2f4fd0389ca6044c340583089d7aaf85cfa3f273145d9188698c84"),
      serviceNodeSignature1: BigInt("0xd345006a1d3c05e78acf5009518654ccee0e91a3c283f3318ad8038ef39efda0"),
      serviceNodeSignature2: BigInt("0x5bd67009d57f0e225374d85877497916705cc6d486785c377cec6e48ffb3c608"),
      fee: 0
    },
    contributors: [
      {
        addr: BigInt("0x66d801a70615979d82c304b7db374d11c232db66"),
        stakedAmount: STAKING_TEST_AMNT,
      }
    ],
    reserved: [
    ]
  }
];

// Withdraw a contributor from the service node contribution contract
// `snContribution`. This function expects to succeed (e.g. the contributor must
// have successfully contributed to the contract prior).
async function withdrawContributor(seshToken, snContribution, contributor) {
    // NOTE: Collect contract initial state
    const contributorTokenBalanceBefore = await seshToken.balanceOf(contributor);
    const contributorAmount             = await snContribution.contributions(contributor);
    const totalContribution             = await snContribution.totalContribution();
    const contributorAddressesLength    = await snContribution.contributorAddressesLength();

    let contributorArrayBefore = [];
    for (let index = 0; index < contributorAddressesLength; index++) {
        const address = await snContribution.contributorAddresses(index);
        contributorArrayBefore.push(address);
    }

    // NOTE: Withdraw contribution
    await snContribution.connect(contributor).withdrawContribution();

    // NOTE: Test stake is withdrawn to contributor
    expect(await seshToken.balanceOf(contributor)).to.equal(contributorTokenBalanceBefore + contributorAmount);

    // NOTE: Test repeated withdraw is allowed but balance should not change because we've already withdrawn
    await expect(snContribution.connect(contributor).withdrawContribution()).to.not.be.reverted;
    expect(await seshToken.balanceOf(contributor)).to.equal(contributorTokenBalanceBefore + contributorAmount);

    // NOTE: Test contract state
    expect(await snContribution.totalContribution()).to.equal(totalContribution - contributorAmount);
    expect(await snContribution.contributorAddressesLength()).to.equal(contributorAddressesLength - BigInt(1));

    // NOTE: Calculate the expected contributor array, emulate the swap-n-pop
    // idiom as used in Solidity.
    let contributorArrayExpected = contributorArrayBefore;
    for (let index = 0; index < contributorArrayExpected.length; index++) {
        if (BigInt(contributorArrayExpected[index][0]) === BigInt(await contributor.getAddress())) {
            contributorArrayExpected[index] = contributorArrayExpected[contributorArrayExpected.length - 1];
            contributorArrayExpected.pop();
            break;
        }
    }

    // NOTE: Query the contributor addresses in the contract
    const contributorArrayLengthAfter = await snContribution.contributorAddressesLength();
    let contributorArray = [];
    for (let index = 0; index < contributorArrayLengthAfter; index++) {
        const address = await snContribution.contributorAddresses(index);
        contributorArray.push(address);
    }

    // NOTE: Compare the contributor array against what we expect
    expect(contributorArrayExpected).to.deep.equal(contributorArray);
}

describe("ServiceNodeContribution Contract Tests", function () {
    // NOTE: Contract factories for deploying onto the blockchain
    let seshTokenContractFactory;
    let snRewardsContractFactory;
    let snContributionContractFactory;

    // NOTE: Contract instances
    let seshToken;             // ERC20 token contract
    let snRewards;             // Rewards contract that pays out SN's
    let snContributionFactory; // Smart contract that deploys `ServiceNodeContribution` contracts
    const beneficiaryData = "0x0000000000000000000000000000000000000000";

    // NOTE: Load the contracts factories in
    before(async function () {
        seshTokenContractFactory      = await ethers.getContractFactory("MockERC20");
        snRewardsContractFactory      = await ethers.getContractFactory("MockServiceNodeRewards");
        snContributionContractFactory = await ethers.getContractFactory("ServiceNodeContributionFactory");

        const [owner, operator] = await ethers.getSigners();
    });

    // NOTE: Initialise the contracts for each test
    beforeEach(async function () {
        // NOTE: Deploy contract instances
        seshToken             = await seshTokenContractFactory.deploy("SESH Token", "SESH", 240_000_000n * 1_000_000_000n);
        snRewards             = await snRewardsContractFactory.deploy(seshToken, STAKING_TEST_AMNT);
        snContributionFactory = await upgrades.deployProxy(snContributionContractFactory, [await snRewards.getAddress()]);
    });

    it("Verify staking rewards contract is set", async function () {
        expect(await snContributionFactory.stakingRewardsContract()).to
                                                                    .equal(await snRewards.getAddress());
    });

    it("Allows deployment of multi-sn contribution contract and emits log correctly", async function () {
        const [owner, operator] = await ethers.getSigners();
        const node = BLS_NODES[0];
        await expect(snContributionFactory.connect(operator)
                                          .deploy(node.blsPubkey,
                                                  node.blsSig,
                                                  node.snParams,
                                                  node.reserved,
                                                  false /*manualFinalize*/)).to.emit(snContributionFactory, 'NewServiceNodeContributionContract');
    });

    describe("Deploy a contribution contract", function () {
        let snContribution;        // Multi-sn contribution contract created by `snContributionFactory`
        let snOperator;            // The owner of the multi-sn contribution contract, `snContribution`
        let snContributionAddress; // The address of the `snContribution` contract

        beforeEach(async function () {
            [snOperator] = await ethers.getSigners();

            // NOTE: Deploy the contract
            const node = BLS_NODES[0];
            const tx = await snContributionFactory.connect(snOperator)
                                                  .deploy(node.blsPubkey,
                                                          node.blsSig,
                                                          node.snParams,
                                                          node.reserved,
                                                          false /*manualFinalize*/);

            // NOTE: Get TX logs to determine contract address
            const receipt                  = await tx.wait();
            const event                    = getContractEvent(receipt.logs, "NewServiceNodeContributionContract");

            expect(event).not.to.be.undefined;

            // NOTE: Get deployed contract address
            snContributionAddress = event.args[0]; // This should be the address of the newly deployed contract
            snContribution        = await ethers.getContractAt("ServiceNodeContribution", snContributionAddress);
        });

         describe("Minimum contribution tests", function () {
             it('Correct minimum contribution when there is one last contributor', async function () {
                 const contributionRemaining = 100;
                 const numberContributors = 9;
                 const maxContributors = 10;

                 const minimumContribution = await snContribution.calcMinimumContribution(
                     contributionRemaining,
                     numberContributors,
                     maxContributors
                 );

                 expect(minimumContribution).to.equal(100);
             });

             it('Correct minimum contribution when there are no contributors', async function () {
                 const contributionRemaining = 15000;
                 const numberContributors = 0;
                 const maxContributors = 4;

                 const minimumContribution = await snContribution.calcMinimumContribution(
                     contributionRemaining,
                     numberContributors,
                     maxContributors
                 );

                 expect(minimumContribution).to.equal(3750);
             });

             it('Equally split minimum contribution across 4 contributors', async function () {
                 let contributionRemaining = BigInt(15000)
                 let numberContributors    = 0;
                 const maxContributors     = 4;
                 for (let numberContributors = 0; numberContributors < maxContributors; numberContributors++) {
                     const minimumContribution  = await snContribution.calcMinimumContribution(contributionRemaining, numberContributors, maxContributors);
                     contributionRemaining     -= minimumContribution;
                     expect(minimumContribution).to.equal(3750);
                 }
                 expect(contributionRemaining).to.equal(0)
             });

             it('Correct minimum contribution after a single contributor', async function () {
                 const contributionRemaining = 15000 - 3750;
                 const numberContributors    = 1;
                 const maxContributors       = 10;

                 const minimumContribution = await snContribution.calcMinimumContribution(
                     contributionRemaining,
                     numberContributors,
                     maxContributors
                 );

                 expect(minimumContribution).to.equal(1250);
             });

             it('Calc min contribution API returns correct operator minimum contribution', async function () {
                 const maxContributors             = await snContribution.maxContributors();
                 const stakingRequirement          = await snContribution.stakingRequirement();
                 const minimumOperatorContribution = await snContribution.minimumOperatorContribution(stakingRequirement);
                 for (let i = 1; i < maxContributors; i++) {
                     const amount = await snContribution.calcMinimumContribution(
                         stakingRequirement,
                         /*numContributors*/ 0,
                         i
                     );
                     expect(amount).to.equal(minimumOperatorContribution);
                 }
             });

             it('Minimum contribution reverts with bad parameters numbers', async function () {
                 const stakingRequirement = await snContribution.stakingRequirement();

                 // NOTE: Test no contributors
                 await expect(snContribution.calcMinimumContribution(stakingRequirement, /*numberContributors*/ 0, /*maxContributors*/ 0)).to
                                                                                                                                          .be
                                                                                                                                          .reverted

                 // NOTE: Test number of contributers greater than max contributors
                 await expect(snContribution.calcMinimumContribution(stakingRequirement, /*numberContributors*/ 3, /*maxContributors*/ 2)).to
                                                                                                                                          .be
                                                                                                                                          .reverted

                 // NOTE: Test 0 staking requirement
                 await expect(snContribution.calcMinimumContribution(0, /*numberContributors*/ 1, /*maxContributors*/ 2)).to
                                                                                                                         .be
                                                                                                                         .reverted

                 // NOTE: Test number of contributors equal to max contributors (e.g. division by 0)
                 await expect(snContribution.calcMinimumContribution(stakingRequirement, /*numberContributors*/ 3, /*maxContributors*/ 3)).to
                                                                                                                                          .be
                                                                                                                                          .reverted
             });
         });

         it("Does not allow contributions if operator hasn't contributed", async function () {
             const [owner, contributor] = await ethers.getSigners();
             const minContribution      = await snContribution.minimumContribution();
             await seshToken.transfer(contributor, TEST_AMNT);
             await seshToken.connect(contributor).approve(snContributionAddress, minContribution);
             await expect(snContribution.connect(contributor).contributeFunds(minContribution, beneficiaryData))
                 .to.be.revertedWithCustomError(snContribution, "FirstContributionMustBeOperator");
         });

         it("Reset contribution contract before operator contributes", async function () {
             await expect(await snContribution.connect(snOperator).reset())
             expect(await snContribution.contributorAddressesLength()).to.equal(0);
             expect(await snContribution.totalContribution()).to.equal(0);
             expect(await snContribution.operatorContribution()).to.equal(0);
         });

         it("Random wallet can not reset contract (test onlyOperator() modifier)", async function () {
             const [owner] = await ethers.getSigners();

             randomWallet = ethers.Wallet.createRandom();
             randomWallet = randomWallet.connect(ethers.provider);
             owner.sendTransaction({to: randomWallet.address, value: BigInt(1 * 10 ** 18)});

             await expect(snContribution.connect(randomWallet)
                                                 .reset()).to
                                                          .be
                                                          .reverted;
         });

         it("Prevents operator contributing less than min amount", async function () {
             const minContribution = await snContribution.minimumContribution();
             await seshToken.transfer(snOperator, TEST_AMNT);
             await seshToken.connect(snOperator).approve(snContributionAddress, minContribution);
             await expect(snContribution.connect(snOperator).contributeFunds(minContribution - BigInt(1), beneficiaryData))
                 .to.be.revertedWithCustomError(snContribution, "ContributionBelowMinAmount");
         });

         it("Allows operator to contribute and records correct balance", async function () {
             const minContribution = await snContribution.minimumContribution();
             await seshToken.transfer(snOperator, TEST_AMNT);
             await seshToken.connect(snOperator).approve(snContributionAddress, minContribution);
             await expect(snContribution.connect(snOperator).contributeFunds(minContribution, beneficiaryData))
                   .to.emit(snContribution, "NewContribution")
                   .withArgs(await snOperator.getAddress(), await snOperator.getAddress(), minContribution);

             await expect(await snContribution.operatorContribution())
                 .to.equal(minContribution);
             await expect(await snContribution.totalContribution())
                 .to.equal(minContribution);
             await expect(await snContribution.contributorAddressesLength())
                 .to.equal(1);
         });

         it("Should be able to rescue before operator contribution", async function () {
             const [owner, contributor1, contributor2] = await ethers.getSigners();

             // NOTE: Transfer tokens to the contract before operator contributed
             await seshToken.transfer(snContribution, TEST_AMNT);

             // NOTE: Check contributors can't rescue the token
             await expect(snContribution.connect(contributor1)
                                        .rescueERC20(seshToken)).to.be.reverted;
             await expect(snContribution.connect(contributor2)
                                        .rescueERC20(seshToken)).to.be.reverted;

             // NOTE: Check that the operator can rescue the tokens
             const balanceBefore = await seshToken.balanceOf(owner);
             expect(await snContribution.connect(owner)
                                        .rescueERC20(seshToken));

             // NOTE: Verify the balances
             const balanceAfter         = await seshToken.balanceOf(owner);
             const contractBalanceAfter = await seshToken.balanceOf(snContribution);
             expect(balanceBefore + BigInt(TEST_AMNT)).to.equal(balanceAfter);
             expect(contractBalanceAfter).to.equal(BigInt(0));

             // NOTE: Tokes are rescued, contract is empty, test that no
             // one can rescue, not even the operator (because the
             // balance of the contract is empty).
             await expect(snContribution.connect(contributor1)
                                        .rescueERC20(seshToken)).to.be.reverted;
             await expect(snContribution.connect(contributor2)
                                        .rescueERC20(seshToken)).to.be.reverted;
             await expect(snContribution.connect(owner)
                                        .rescueERC20(seshToken)).to.be.reverted;
         });

         describe("After operator has set up funds", function () {
             beforeEach(async function () {
                 const [owner]         = await ethers.getSigners();
                 const minContribution = await snContribution.minimumContribution();

                 await seshToken.transfer(snOperator, TEST_AMNT);
                 await seshToken.connect(snOperator).approve(snContributionAddress, minContribution);
                 await expect(snContribution.connect(snOperator)
                                            .contributeFunds(minContribution, beneficiaryData)).to
                                                                             .emit(snContribution, "NewContribution")
                                                                             .withArgs(await snOperator.getAddress(), await snOperator.getAddress(), minContribution);
             });

             it("Should be able to contribute funds as a contributor", async function () {
                 const [owner, contributor] = await ethers.getSigners();
                 const minContribution = await snContribution.minimumContribution();
                 let previousContribution = await snContribution.totalContribution();
                 await seshToken.transfer(contributor, TEST_AMNT);
                 await seshToken.connect(contributor).approve(snContribution, minContribution);
                 await expect(snContribution.connect(contributor).contributeFunds(minContribution, beneficiaryData))
                       .to.emit(snContribution, "NewContribution")
                       .withArgs(await contributor.getAddress(), await contributor.getAddress(), minContribution);
                 await expect(await snContribution.operatorContribution())
                     .to.equal(previousContribution);
                 await expect(await snContribution.totalContribution())
                     .to.equal(previousContribution + minContribution);
                 await expect(await snContribution.contributorAddressesLength())
                     .to.equal(2);
             });

             it("Should allow operator top-ups", async function() {
                 const minContribution = await snContribution.minimumContribution();
                 const topup = BigInt(9_000000000);
                 await expect(topup).to.be.below(minContribution)
                 const currTotal = await snContribution.totalContribution();
                 await seshToken.connect(snOperator).approve(snContribution, topup);
                 await expect(snContribution.connect(snOperator).contributeFunds(topup, beneficiaryData))
                       .to.emit(snContribution, "NewContribution")
                       .withArgs(await snOperator.getAddress(), await snOperator.getAddress(), topup);
                 await expect(await snContribution.operatorContribution())
                     .to.equal(currTotal + topup);
                 await expect(await snContribution.totalContribution())
                     .to.equal(currTotal + topup);
                 await expect(await snContribution.contributorAddressesLength())
                     .to.equal(1);
                 await expect(await snContribution.minimumContribution()).to.equal(
                     minContribution - BigInt(1_000000000));

                 await expect(await snContribution.getContributions()).to.deep.equal(
                         [[snOperator.address], /*beneficiary*/ [snOperator.address], [BigInt(STAKING_TEST_AMNT / 4 + 9_000000000)]])
             });

             describe("Should be able to have multiple contributors w/min contribution", async function () {
                 beforeEach(async function () {
                     // NOTE: Get operator contribution
                     const [owner, contributor1, contributor2] = await ethers.getSigners();
                     const previousContribution                = await snContribution.totalContribution();

                     // NOTE: Contributor 1 w/ minContribution()
                     const minContribution1                   = await snContribution.minimumContribution();
                     await seshToken.transfer(contributor1, minContribution1);
                     await seshToken.connect(contributor1).approve(snContribution, minContribution1);
                     await expect(snContribution.connect(contributor1)
                                                         .contributeFunds(minContribution1, beneficiaryData)).to
                                                                                            .emit(snContribution, "NewContribution")
                                                                                            .withArgs(await contributor1.getAddress(), await contributor1.getAddress(), minContribution1);

                     // NOTE: Contributor 2 w/ minContribution()
                     const minContribution2 = await snContribution.minimumContribution();
                     await seshToken.transfer(contributor2, minContribution2);
                     await seshToken.connect(contributor2)
                                    .approve(snContribution,
                                            minContribution2);
                     await expect(snContribution.connect(contributor2)
                                                         .contributeFunds(minContribution2, beneficiaryData)).to
                                                                                            .emit(snContribution, "NewContribution")
                                                                                            .withArgs(await contributor2.getAddress(), await contributor2.getAddress(), minContribution2);

                     // NOTE: Check contribution values
                     expect(await snContribution.operatorContribution()).to
                                                                        .equal(previousContribution);
                     expect(await snContribution.totalContribution()).to
                                                                     .equal(previousContribution + minContribution1 + minContribution2);
                     expect(await snContribution.contributorAddressesLength()).to
                                                                              .equal(3);
                 });

                 it("Should allow contributor top-ups", async function() {
                     const [owner, contributor1, contributor2] = await ethers.getSigners();
                     const minContribution = await snContribution.minimumContribution();
                     const initialOperatorContrib = await snContribution.operatorContribution();
                     const initialContribution = await snContribution.totalContribution();

                     const topup1 = BigInt(1_000000000);
                     await seshToken.transfer(contributor1, topup1);
                     await expect(topup1).to.be.below(minContribution)
                     await seshToken.connect(contributor1).approve(snContribution, topup1);
                     await expect(snContribution.connect(contributor1).contributeFunds(topup1, beneficiaryData))
                           .to.emit(snContribution, "NewContribution")
                           .withArgs(await contributor1.getAddress(), await contributor1.getAddress(), topup1);

                     const minContribution2 = await snContribution.minimumContribution();
                     const topup2 = BigInt(13_000000000);
                     await seshToken.transfer(contributor2, topup2);
                     await expect(topup2).to.be.below(minContribution2)
                     await seshToken.connect(contributor2).approve(snContribution, topup2);
                     await expect(snContribution.connect(contributor2).contributeFunds(topup2, beneficiaryData))
                           .to.emit(snContribution, "NewContribution")
                           .withArgs(await contributor2.getAddress(), await  contributor2.getAddress(), topup2);

                     await expect(await snContribution.operatorContribution())
                         .to.equal(initialOperatorContrib);
                     await expect(await snContribution.totalContribution())
                         .to.equal(initialContribution + topup1 + topup2);
                     await expect(await snContribution.contributorAddressesLength())
                         .to.equal(3);
                     await expect(await snContribution.minimumContribution()).to.equal(
                         minContribution - BigInt(2_000000000));

                     await expect(await snContribution.getContributions()).to.deep.equal(
                         [
                             [owner.address, contributor1.address, contributor2.address],
                             [owner.address, contributor1.address, contributor2.address],
                             [BigInt(STAKING_TEST_AMNT / 4), BigInt(STAKING_TEST_AMNT / 12 + 1_000000000), BigInt(STAKING_TEST_AMNT / 12 + 13_000000000)]
                         ])
                 });

                  describe("Withdraw contributor 1", async function () {
                      beforeEach(async function () {
                          const [owner, contributor1, contributor2] = await ethers.getSigners();

                          // NOTE: Advance time
                          await network.provider.send("evm_increaseTime", [60 * 60 * 24]);
                          await network.provider.send("evm_mine");

                          await withdrawContributor(seshToken, snContribution, contributor1);
                      });

                      describe("Withdraw contributor 2", async function () {
                          beforeEach(async function () {
                              const [owner, contributor1, contributor2] = await ethers.getSigners();
                              await withdrawContributor(seshToken, snContribution, contributor2);
                          });

                          describe("Contributor 1, 2 rejoin", async function() {
                              beforeEach(async function() {
                                  // NOTE: Get operator contribution
                                  const [owner, contributor1, contributor2] = await ethers.getSigners();
                                  const previousContribution                = await snContribution.totalContribution();

                                  const stakingRequirement = await snContribution.stakingRequirement();
                                  expect(previousContribution).to.equal(await snContribution.minimumOperatorContribution(stakingRequirement));

                                  // NOTE: Contributor 1 w/ minContribution()
                                  const minContribution1                   = await snContribution.minimumContribution();
                                  await seshToken.transfer(contributor1, minContribution1);
                                  await seshToken.connect(contributor1).approve(snContribution, minContribution1);
                                  await expect(snContribution.connect(contributor1)
                                                                      .contributeFunds(minContribution1, beneficiaryData)).to
                                                                                                         .emit(snContribution, "NewContribution")
                                                                                                         .withArgs(await contributor1.getAddress(), await contributor1.getAddress(), minContribution1);

                                  // NOTE: Contributor 2 w/ minContribution()
                                  const minContribution2 = await snContribution.minimumContribution();
                                  await seshToken.transfer(contributor2, minContribution2);
                                  await seshToken.connect(contributor2)
                                                 .approve(snContribution,
                                                         minContribution2);
                                  await expect(snContribution.connect(contributor2)
                                                                      .contributeFunds(minContribution2, beneficiaryData)).to
                                                                                                         .emit(snContribution, "NewContribution")
                                                                                                         .withArgs(await contributor2.getAddress(), await contributor2.getAddress(), minContribution2);

                                  // NOTE: Check contribution values
                                  expect(await snContribution.operatorContribution()).to
                                                                                     .equal(previousContribution);
                                  expect(await snContribution.totalContribution()).to
                                                                                  .equal(previousContribution + minContribution1 + minContribution2);
                                  expect(await snContribution.contributorAddressesLength()).to
                                                                                           .equal(3);
                              });

                              it("Reset node and check contributor funds have been returned", async function() {
                                  const [owner, contributor1, contributor2] = await ethers.getSigners();
                                  // Get initial balances
                                  const initialBalance1 = await seshToken.balanceOf(contributor1.address);
                                  const initialBalance2 = await seshToken.balanceOf(contributor2.address);
                                  // Get contribution amounts
                                  const contribution1 = await snContribution.contributions(contributor1.address);
                                  const contribution2 = await snContribution.contributions(contributor2.address);
                                  // Cancel the node
                                  // await snContribution.connect(owner).reset();
                                  // Check final balances
                                  // const finalBalance1 = await seshToken.balanceOf(contributor1.address);
                                  // const finalBalance2 = await seshToken.balanceOf(contributor2.address);
                                  // expect(finalBalance1).to.equal(initialBalance1 + contribution1);
                                  // expect(finalBalance2).to.equal(initialBalance2 + contribution2);
                              });
                          });
                      });
                  });
             });

             it("Max contributors cannot be exceeded", async function () {
                 expect(await snContribution.contributorAddressesLength()).to.equal(1); // SN operator
                 expect(await snContribution.maxContributors()).to.equal(await snRewards.maxContributors());

                 const signers         = [];
                 const maxContributors = Number(await snContribution.maxContributors()) - 1; // Remove SN operator from list

                 for (let i = 0; i < maxContributors + 1 /*Add one more to exceed*/; i++) {
                     // NOTE: Create wallet
                     let wallet = await ethers.Wallet.createRandom();
                     wallet     = wallet.connect(ethers.provider);

                     // NOTE: Fund the wallet
                     await seshToken.transfer(await wallet.getAddress(), TEST_AMNT);
                     await snOperator.sendTransaction({
                         to:    await wallet.getAddress(),
                         value: ethers.parseEther("1.0")
                     });

                     signers.push(wallet);
                 }

                 // NOTE: Contribute
                 const stakingRequirement = await snContribution.stakingRequirement();
                 const minContribution = await snContribution.minimumContribution();

                 for (let i = 0; i < signers.length; i++) {
                     const signer          = signers[i];
                     await seshToken.connect(signer).approve(snContribution, minContribution);

                     if (i == (signers.length - 1)) {
                         await expect(snContribution.connect(signer)
                                                    .contributeFunds(minContribution, beneficiaryData)).to
                                                                                      .be
                                                                                      .reverted;
                     } else {
                         const runningContribution     = await snContribution.totalContribution();
                         const expectFinalizedEventEmit = (runningContribution + minContribution) == runningContribution;
                         if (expectFinalizedEventEmit) {
                             await expect(snContribution.connect(signer)
                                                        .contributeFunds(minContribution, beneficiaryData)).to
                                                                                          .emit(snContribution, "NewContribution")
                                                                                          .emit(snContribution, "Finalized")
                                                                                          .withArgs(await signer.getAddress(), await signer.getAddress(), minContribution);
                         } else {
                             await expect(snContribution.connect(signer)
                                                        .contributeFunds(minContribution, beneficiaryData)).to
                                                                                          .emit(snContribution, "NewContribution")
                                                                                          .withArgs(await signer.getAddress(), await signer.getAddress(), minContribution);
                         }
                     }
                 }

                 expect(await snContribution.totalContribution()).to.equal(await snContribution.stakingRequirement());
                 expect(await snContribution.contributorAddressesLength()).to.equal(await snContribution.maxContributors());
                 expect(await snContribution.status()).to.equal(SN_CONTRIB_Status_Finalized);
             });

             it("Should not finalise if not full", async function () {
                 const [owner, contributor] = await ethers.getSigners();
                 const minContribution = await snContribution.minimumContribution();
                 let previousContribution = await snContribution.totalContribution();
                 await seshToken.transfer(contributor, minContribution);
                 await seshToken.connect(contributor).approve(snContribution, minContribution);

                 await expect(await snContribution.connect(contributor).contributeFunds(minContribution, beneficiaryData))
                     .to.emit(snContribution, "NewContribution")
                     .withArgs(await contributor.getAddress(), await contributor.getAddress(), minContribution);

                 await expect(snContribution.finalize()).to.be.reverted;

                 await expect(await snContribution.connect(snOperator).status()).to.equal(SN_CONTRIB_Status_OpenForPublicContrib)
                 await expect(await seshToken.balanceOf(snContribution))
                     .to.equal(previousContribution + minContribution);
             });

             it("Should not be able to overcapitalize", async function () {
                 const [owner, contributor, contributor2] = await ethers.getSigners();
                 const stakingRequirement = await snContribution.stakingRequirement();
                 let previousContribution = await snContribution.totalContribution();
                 await seshToken.transfer(contributor, stakingRequirement - previousContribution);
                 await seshToken.connect(contributor).approve(snContribution, stakingRequirement - previousContribution + BigInt(1));
                 await expect(snContribution.connect(contributor).contributeFunds(stakingRequirement - previousContribution + BigInt(1), beneficiaryData))
                     .to.be.revertedWithCustomError(snContribution, "ContributionExceedsStakingRequirement");
             });

             it("Should not be able to rescue before finalisation", async function () {
                 const [owner, contributor1, contributor2] = await ethers.getSigners();

                 // NOTE: Check contributors can't rescue the token
                 await expect(snContribution.connect(contributor1)
                                            .rescueERC20(seshToken)).to.be.reverted;
                 await expect(snContribution.connect(contributor2)
                                            .rescueERC20(seshToken)).to.be.reverted;

                 // NOTE: Check that the operator can't rescue the tokens
                 await expect(snContribution.connect(owner).rescueERC20(seshToken))
                     .to.be.reverted;
             });

             describe("Turn off auto-finalize, fill node", async function () {
                 beforeEach(async function () {
                     // NOTE: Turn off auto-finalize
                     await snContribution.updateManualFinalize(true);

                     // NOTE: Fill node
                     const [owner, contributor1] = await ethers.getSigners();
                     const stakingRequirement    = await snContribution.stakingRequirement();
                     const previousContribution  = await snContribution.totalContribution();

                     await seshToken.transfer(contributor1, stakingRequirement - previousContribution);
                     await seshToken.connect(contributor1)
                                    .approve(snContribution, stakingRequirement - previousContribution);

                     await expect(await snContribution.connect(contributor1).contributeFunds(stakingRequirement - previousContribution, beneficiaryData)).to.not.be.reverted;
                     expect(await seshToken.balanceOf(snContribution)).to.equal(stakingRequirement);

                 });

                 it("Manually finalize", async function () {
                     await expect(await snContribution.connect(snOperator).finalize()).to.not.be.reverted; // Test we need to manually finalized
                     const stakingRequirement = await snContribution.stakingRequirement();
                     expect(await seshToken.balanceOf(snRewards)).to.equal(stakingRequirement);
                     expect(await snRewards.totalNodes()).to.equal(1);

                     await expect(await snContribution.connect(snOperator).status()).to.equal(SN_CONTRIB_Status_Finalized);
                     expect(await seshToken.balanceOf(snContribution)).to.equal(0);
                 });

                 it("Withdraw and check status", async function () {
                     const [owner, contributor1] = await ethers.getSigners();

                     // NOTE: Attempting to withdraw after 24 hours
                     await network.provider.send("evm_increaseTime", [60 * 60 * 24]); // Fast forward time by 24 hours
                     await network.provider.send("evm_mine");
                     await expect(await snContribution.connect(contributor1).withdrawContribution()).to.not.be.reverted;

                     // NOTE: Check contract status reverted correctly
                     await expect(await snContribution.connect(snOperator).status()).to.equal(SN_CONTRIB_Status_OpenForPublicContrib);
                 });

                 it("Withdraw and re-contribute using another contributor and finalize", async function () {
                     const [owner, contributor1, contributor2] = await ethers.getSigners();
                     const stakingRequirement                  = await snContribution.stakingRequirement();

                     // NOTE: Withdraw after 24 hours
                     await network.provider.send("evm_increaseTime", [60 * 60 * 24]); // Fast forward time by 24 hours
                     await network.provider.send("evm_mine");
                     await expect(await snContribution.connect(contributor1).withdrawContribution()).to.not.be.reverted;

                     // NOTE: Contribute as contributor2
                     const prevContribAmount = await snContribution.totalContribution();
                     const contribAmount     = stakingRequirement - prevContribAmount;
                     await seshToken.transfer(contributor2, contribAmount);
                     await seshToken.connect(contributor2)
                                    .approve(snContribution, contribAmount);
                     await expect(await snContribution.connect(contributor2).contributeFunds(contribAmount, beneficiaryData)).to.not.be.reverted;

                     // NOTE: Finalize
                     await expect(await snContribution.connect(snOperator).finalize()).to.not.be.reverted; // Test we need to manually finalized
                     expect(await seshToken.balanceOf(snRewards)).to.equal(stakingRequirement);
                     expect(await snRewards.totalNodes()).to.equal(1);

                     await expect(await snContribution.connect(snOperator).status()).to.equal(SN_CONTRIB_Status_Finalized);
                     expect(await seshToken.balanceOf(snContribution)).to.equal(0);
                 });

                 it("Withdraw operator", async function () {
                     const [owner] = await ethers.getSigners();
                     await expect(await snContribution.connect(owner).withdrawContribution()).to.not.be.reverted;

                     // NOTE: Check all funds are returned and contract state is reverted
                     await expect(await snContribution.connect(snOperator).status()).to.equal(SN_CONTRIB_Status_WaitForOperatorContrib);
                     expect(await seshToken.balanceOf(snContribution)).to.equal(0);
                 })
             })

             describe("Finalise w/ 1 contributor", async function () {
                 beforeEach(async function () {
                     const [owner, contributor1] = await ethers.getSigners();
                     const stakingRequirement = await snContribution.stakingRequirement();
                     let previousContribution = await snContribution.totalContribution();

                     await seshToken.transfer(contributor1, stakingRequirement - previousContribution);
                     await seshToken.connect(contributor1)
                                    .approve(snContribution, stakingRequirement - previousContribution);

                     await expect(await snContribution.connect(contributor1).contributeFunds(stakingRequirement - previousContribution, beneficiaryData)).to.not.be.reverted;
                     expect(await seshToken.balanceOf(snRewards)).to.equal(stakingRequirement);
                     expect(await snRewards.totalNodes()).to.equal(1);

                     await expect(await snContribution.connect(snOperator).status()).to.equal(SN_CONTRIB_Status_Finalized);
                     expect(await seshToken.balanceOf(snContribution)).to.equal(0);
                 });

                 it("Check withdraw is no-op via operator and contributor", async function () {
                     const [owner, contributor1, contributor2] = await ethers.getSigners();
                     await expect(snContribution.connect(owner).withdrawContribution()).to.not.emit;
                     await expect(snContribution.connect(contributor1).withdrawContribution()).to.not.emit;
                     await expect(snContribution.connect(contributor2).withdrawContribution()).to.not.emit;
                 });

                 it("Check reset contract is reverted with invalid parameters", async function () {
                     const [owner, contributor1, contributor2] = await ethers.getSigners();
                     const zero                                = BigInt(0);
                     const one                                 = BigInt(1);

                     // NOTE: Test reset w/ contributor1 and contributor2 (of
                     // which contributor2 is not one of the actual
                     // contributors of the contract).
                     await expect(snContribution.connect(contributor1).reset()).to
                                                                               .be
                                                                               .reverted;
                     await expect(snContribution.connect(contributor2).reset()).to
                                                                               .be
                                                                               .reverted;
                 });

                 it("Check reset contract works with min contribution", async function () {
                     const [owner, contributor1, contributor2] = await ethers.getSigners();
                     const stakingRequirement                  = await snContribution.stakingRequirement();
                     const minOperatorContribution             = await snContribution.minimumOperatorContribution(stakingRequirement);

                     // NOTE: Test reset w/ operator
                     const blsSignatureBefore      = await snContribution.blsSignature();
                     const blsPubkeyBefore         = await snContribution.blsPubkey();
                     const serviceNodeParamsBefore = await snContribution.serviceNodeParams();
                     const maxContributorsBefore   = await snContribution.maxContributors();

                     await seshToken.connect(owner).approve(snContributionAddress, minOperatorContribution);
                     await expect(snContribution.connect(owner).reset()).to.not.be.reverted;
                     await expect(snContribution.connect(owner).contributeFunds(minOperatorContribution, beneficiaryData)).to
                                                                                                         .emit(snContribution, "NewContribution");

                     // NOTE: Verify contract state
                     expect(await snContribution.contributorAddressesLength()).to.equal(1);
                     expect(await snContribution.contributions(owner)).to.equal(minOperatorContribution);

                     const contributorAddresses = await snContribution.contributorAddresses(0);
                     expect(contributorAddresses[0]).to.equal(await owner.getAddress()); // Staker address
                     expect(contributorAddresses[1]).to.equal(await owner.getAddress()); // Beneficiary

                     expect(await snContribution.status()).to.equal(SN_CONTRIB_Status_OpenForPublicContrib);
                     expect(await snContribution.blsSignature()).to.deep.equal(blsSignatureBefore);
                     expect(await snContribution.blsPubkey()).to.deep.equal(blsPubkeyBefore);
                     expect(await snContribution.serviceNodeParams()).to.deep.equal(serviceNodeParamsBefore);
                     expect(await snContribution.maxContributors()).to.equal(maxContributorsBefore);
                 });

                 it("Check we can rescue ERC20 tokens sesh after finalisation", async function() {
                     const [owner, contributor1, contributor2] = await ethers.getSigners();

                     // NOTE: Check that the contract SESH balance is empty
                     const contractBalance = await seshToken.balanceOf(snContribution);
                     expect(contractBalance).to.equal(BigInt(0));

                     // NOTE: Transfer tokens to the contract after it was finalised
                     await seshToken.transfer(snContribution, TEST_AMNT);

                     // NOTE: Check contributors can't rescue the token
                     await expect(snContribution.connect(contributor1)
                                                .rescueERC20(seshToken)).to.be.reverted;
                     await expect(snContribution.connect(contributor2)
                                                .rescueERC20(seshToken)).to.be.reverted;

                     // NOTE: Check that the operator can rescue the tokens
                     const balanceBefore = await seshToken.balanceOf(owner);
                     expect(await snContribution.connect(owner)
                                                .rescueERC20(seshToken));

                     // NOTE: Verify the balances
                     const balanceAfter         = await seshToken.balanceOf(owner);
                     const contractBalanceAfter = await seshToken.balanceOf(snContribution);
                     expect(balanceBefore + BigInt(TEST_AMNT)).to.equal(balanceAfter);
                     expect(contractBalanceAfter).to.equal(BigInt(0));

                     // NOTE: Tokes are rescued, contract is empty, test that no
                     // one can rescue, not even the operator (because the
                     // balance of the contract is empty).
                     await expect(snContribution.connect(contributor1)
                                                .rescueERC20(seshToken)).to.be.reverted;
                     await expect(snContribution.connect(contributor2)
                                                .rescueERC20(seshToken)).to.be.reverted;
                     await expect(snContribution.connect(owner)
                                                .rescueERC20(seshToken)).to.be.reverted;
                 });
             });

             it("Should allow operator to withdraw (which resets the contract)", async function () {
                 const [owner, contributor] = await ethers.getSigners();
                 await snContribution.connect(owner).withdrawContribution();
                 await expect(await snContribution.status()).to.equal(SN_CONTRIB_Status_WaitForOperatorContrib)
             });

             it("Should revert withdrawal if less than 24 hours have passed", async function () {
                 const [owner, contributor] = await ethers.getSigners();
                 const minContribution = await snContribution.minimumContribution();
                 // Setting up contribution
                 await seshToken.transfer(contributor, TEST_AMNT);
                 await seshToken.connect(contributor).approve(snContribution, minContribution);
                 await snContribution.connect(contributor).contributeFunds(minContribution, beneficiaryData);

                 // Attempting to withdraw before 24 hours
                 await network.provider.send("evm_increaseTime", [60 * 60 * 23]); // Fast forward time by 23 hours
                 await network.provider.send("evm_mine");

                 // This withdrawal should fail
                 await expect(snContribution.connect(contributor).withdrawContribution())
                     .to.be.revertedWithCustomError(snContribution, "WithdrawTooEarly");
             });

             it("Should allow withdrawal and return funds after 24 hours have passed", async function () {
                 const [owner, contributor] = await ethers.getSigners();
                 const minContribution = await snContribution.minimumContribution();
                 // Setting up contribution
                 await seshToken.transfer(contributor, TEST_AMNT);
                 await seshToken.connect(contributor).approve(snContribution, minContribution);
                 await snContribution.connect(contributor).contributeFunds(minContribution, beneficiaryData);

                 // Waiting for 24 hours
                 await network.provider.send("evm_increaseTime", [60 * 60 * 24]); // Fast forward time by 24 hours
                 await network.provider.send("evm_mine");

                 // Checking the initial balance before withdrawal
                 const initialBalance = await seshToken.balanceOf(contributor.getAddress());

                 // Performing the withdrawal
                 await expect(snContribution.connect(contributor).withdrawContribution())
                     .to.emit(snContribution, "WithdrawContribution")
                     .withArgs(await contributor.getAddress(), minContribution);

                 // Verify that the funds have returned to the contributor
                 const finalBalance = await seshToken.balanceOf(contributor.getAddress());
                 expect(finalBalance).to.equal(initialBalance + minContribution);
            });
         });
    });

    describe("Reserved Contributions testing minimum amounts", function () {
        let snOperator;
        let snContributionAddress;
        let reservedContributor1;
        let reservedContributor2;
        let reservedContributor3;
        let ownerContribution;

        beforeEach(async function () {
            [snOperator, reservedContributor1, reservedContributor2, reservedContributor3] = await ethers.getSigners();
            const node = BLS_NODES[0];
            let tx = await snContributionFactory.connect(snOperator)
                                                .deploy(node.blsPubkey,
                                                        node.blsSig,
                                                        node.snParams,
                                                        [],
                                                        false /*manualFinalize*/);

            const receipt = await tx.wait();
            const event = getContractEvent(receipt.logs, "NewServiceNodeContributionContract");
            snContributionAddress = event.args[0];
            snContribution = await ethers.getContractAt("ServiceNodeContribution", snContributionAddress);

            ownerContribution = await snContribution.minimumContribution();
            await seshToken.transfer(snOperator, TEST_AMNT);
            await seshToken.connect(snOperator).approve(snContributionAddress, ownerContribution);
        });

        it("should succeed with valid reserved contributions: [25% operator, 10%, 10%, 15%, 40%]", async function () {
            const reservedContributors = [
                { addr: await snOperator.getAddress(),        amount: ownerContribution            },
                { addr: reservedContributor1.address,         amount: STAKING_TEST_AMNT * 10 / 100 },
                { addr: reservedContributor2.address,         amount: STAKING_TEST_AMNT * 10 / 100 },
                { addr: reservedContributor3.address,         amount: STAKING_TEST_AMNT * 15 / 100 },
                { addr: ethers.Wallet.createRandom().address, amount: STAKING_TEST_AMNT * 40 / 100 }
            ];

            await expect(snContribution.connect(snOperator).updateReservedContributors(reservedContributors)).to.not.be.reverted;
            await expect(await snContribution.getReserved()).to.deep.equal(
                [
                    /*Addresses*/ [reservedContributors[0].addr,   reservedContributors[1].addr,   reservedContributors[2].addr,   reservedContributors[3].addr,   reservedContributors[4].addr],
                    /*Amount*/    [reservedContributors[0].amount, reservedContributors[1].amount, reservedContributors[2].amount, reservedContributors[3].amount, reservedContributors[4].amount],
                    /*Received*/  [false,                          false,                          false,                          false,                          false]
                ]);

            await expect(snContribution.connect(snOperator).contributeFunds(ownerContribution, beneficiaryData)).to.not.be.reverted;
            await expect(await snContribution.getReserved()).to.deep.equal(
                [
                    /*Addresses*/ [reservedContributors[0].addr,   reservedContributors[1].addr,   reservedContributors[2].addr,   reservedContributors[3].addr,   reservedContributors[4].addr],
                    /*Amount*/    [reservedContributors[0].amount, reservedContributors[1].amount, reservedContributors[2].amount, reservedContributors[3].amount, reservedContributors[4].amount],
                    /*Received*/  [true,                           false,                          false,                          false,                          false]
                ]);

        });

        it("should fail with duplicate reserved contributions", async function () {
            const reservedContributors = [
                { addr: await snOperator.getAddress(), amount: ownerContribution },
                { addr: reservedContributor1.address, amount: STAKING_TEST_AMNT * 10 / 100 },
                { addr: reservedContributor1.address, amount: STAKING_TEST_AMNT * 15 / 100 },
            ];

            await expect(snContribution.connect(snOperator).updateReservedContributors(reservedContributors)).to.be.revertedWithCustomError(snContribution, "DuplicateAddressInReservedContributor");
        });

        it("should fail with invalid reserved contributions: [25% operator, 10%, 5%]", async function () {
            const reservedContributors = [
                { addr: await snOperator.getAddress(),                   amount: ownerContribution },
                { addr: reservedContributor1.address, amount: STAKING_TEST_AMNT * 10 / 100 },
                { addr: reservedContributor2.address, amount: STAKING_TEST_AMNT * 5 / 100 }
            ];

            await expect(snContribution.connect(snOperator).updateReservedContributors(reservedContributors))
                .to.be.revertedWithCustomError(snContribution, "ReservedContributionBelowMinAmount");
        });

        it("should succeed with valid reserved contributions: [25% operator, 70%, 5%]", async function () {
            const reservedContributors = [
                { addr: await snOperator.getAddress(), amount: ownerContribution },
                { addr: reservedContributor1.address, amount: STAKING_TEST_AMNT * 70 / 100 },
                { addr: reservedContributor2.address, amount: STAKING_TEST_AMNT * 5 / 100 }
            ];

            await expect(snContribution.connect(snOperator).updateReservedContributors(reservedContributors)).to.not.be.reverted;
            await expect(snContribution.connect(snOperator).contributeFunds(ownerContribution, beneficiaryData)).to.not.be.reverted;
        });

        it("should fail with invalid reserved contributions order: [25%, 5%, 70%]", async function () {
            const reservedContributors = [
                { addr: await snOperator.getAddress(), amount: ownerContribution },
                { addr: reservedContributor1.address, amount: STAKING_TEST_AMNT * 5 / 100 },
                { addr: reservedContributor2.address, amount: STAKING_TEST_AMNT * 70 / 100 }
            ];

            await expect(snContribution.connect(snOperator).updateReservedContributors(reservedContributors))
                .to.be.revertedWithCustomError(snContribution, "ReservedContributionBelowMinAmount");
        });

        it("should fail if operator contribution is explicitly less than 25%", async function () {
            const reservedContributors = [
                { addr: await snOperator.getAddress(),                   amount: ownerContribution - 1n},
                { addr: reservedContributor1.address, amount: STAKING_TEST_AMNT * 75 / 100 }
            ];

            await expect(snContribution.connect(snOperator).updateReservedContributors(reservedContributors))
                .to.be.revertedWithCustomError(snContribution, "ReservedContributionBelowMinAmount");
        });

        it("should fail if operator contribution is implicitly less than 25%", async function () {
            const reservedContributors = [
                { addr: await snOperator.getAddress(), amount: ownerContribution },
                { addr: reservedContributor1.address, amount: (STAKING_TEST_AMNT * 75 / 100) + 1}
            ];

            await expect(snContribution.connect(snOperator).updateReservedContributors(reservedContributors)).to.be.reverted;
        });

        it("should succeed with exactly 25% operator stake", async function () {
            const reservedContributors = [
                { addr: await snOperator.getAddress(), amount: ownerContribution },
                { addr: reservedContributor1.address, amount: STAKING_TEST_AMNT * 75 / 100 }
            ];

            await expect(snContribution.connect(snOperator).updateReservedContributors(reservedContributors)).to.not.be.reverted;
            await expect(snContribution.connect(snOperator).contributeFunds(ownerContribution, beneficiaryData)).to.not.be.reverted;
        });

        it("should fail if total contributions exceed 100%", async function () {
            const reservedContributors = [
                { addr: await snOperator.getAddress(), amount: ownerContribution },
                { addr: reservedContributor1.address, amount: STAKING_TEST_AMNT * 50 / 100 },
                { addr: reservedContributor2.address, amount: STAKING_TEST_AMNT * 30 / 100 }
            ];

            await expect(snContribution.connect(snOperator).updateReservedContributors(reservedContributors))
                .to.be.revertedWithCustomError(snContribution, "ReservedContributionExceedsStakingRequirement");
        });
    });

    describe("Reserved Contributions", function () {
        let snContribution;
        let snOperator;
        let snContributionAddress;
        let reservedContributor1;
        let reservedContributor2;
        let contribution1     = STAKING_TEST_AMNT / 3;
        let contribution2     = STAKING_TEST_AMNT / 4;
        let ownerContribution = STAKING_TEST_AMNT / 4;

        beforeEach(async function () {
            [snOperator, reservedContributor1, reservedContributor2] = await ethers.getSigners();

            const reservedContributors = [
                { addr: snOperator,                   amount: ownerContribution },
                { addr: reservedContributor1.address, amount: contribution1 },
                { addr: reservedContributor2.address, amount: contribution2 }
            ];

            const node = BLS_NODES[0];
            const tx = await snContributionFactory.connect(snOperator)
                                                  .deploy(node.blsPubkey,
                                                          node.blsSig,
                                                          node.snParams,
                                                          reservedContributors,
                                                          false /*manualFinalize*/);

            const receipt         = await tx.wait();
            const event           = getContractEvent(receipt.logs, "NewServiceNodeContributionContract");
            snContributionAddress = event.args[0];
            snContribution        = await ethers.getContractAt("ServiceNodeContribution", snContributionAddress);

            await seshToken.transfer(snOperator, TEST_AMNT);
            await seshToken.connect(snOperator).approve(snContributionAddress, ownerContribution);
            await snContribution.connect(snOperator).contributeFunds(ownerContribution, beneficiaryData);
        });

        it("Should correctly set reserved contributions", async function () {
            const [reservedContribution1, received1] = await snContribution.reservedContributions(reservedContributor1.address);
            const [reservedContribution2, received2] = await snContribution.reservedContributions(reservedContributor2.address);

            expect(reservedContribution1).to.equal(contribution1);
            expect(received1).to.equal(false);

            expect(reservedContribution2).to.equal(contribution2);
            expect(received2).to.equal(false);
        });

        it("Should correctly calculate total reserved contribution", async function () {
            const totalReserved = await snContribution.totalReservedContribution();
            expect(totalReserved).to.equal(contribution1 + contribution2);
        });

        it("Should allow reserved contributor to contribute reserved funds", async function () {
            // NOTE: Check total reserved contribution initial conditions
            {
                const totalReserved = await snContribution.totalReservedContribution();
                expect(totalReserved).to.equal(contribution1 + contribution2);
            }

            // NOTE: Check reserved slot initial conditions
            {
                const [remainingReserved, received] = await snContribution.reservedContributions(reservedContributor1.address);
                expect(remainingReserved).to.equal(contribution1);
                expect(received).to.equal(false);
            }

            // NOTE: Fund reserved contributor 1
            await seshToken.transfer(reservedContributor1.address, contribution1);

            // NOTE: Contribute to the contract
            await seshToken.connect(reservedContributor1).approve(snContribution.getAddress(), contribution1);
            await expect(snContribution.connect(reservedContributor1).contributeFunds(contribution1, beneficiaryData))
                .to.emit(snContribution, "NewContribution")
                .withArgs(reservedContributor1.address, reservedContributor1.address, contribution1);

            // NOTE: Check contribution is registered
            const contribution = await snContribution.contributions(reservedContributor1.address);
            expect(contribution).to.equal(contribution1);

            // NOTE: Check reserved slot is updated
            {
                const [remainingReserved, received] = await snContribution.reservedContributions(reservedContributor1.address);
                expect(remainingReserved).to.equal(contribution1);
                expect(received).to.equal(true);
            }

            await expect(await snContribution.getReserved()).to.deep.equal(
                [
                    /*Addresses*/ [await snOperator.getAddress(),  await reservedContributor1.getAddress(), await reservedContributor2.getAddress()],
                    /*Amount*/    [ownerContribution,              contribution1,                           contribution2],
                    /*Received*/  [true,                           true,                                    false]
                ]);

            // NOTE: Check total reserved contribution helper excludes the contributed amount
            {
                const totalReserved = await snContribution.totalReservedContribution();
                expect(totalReserved).to.equal(contribution2);
            }
        });

        it("Should prevent reserved contributor to contribute less than their reserved funds", async function () {
            await seshToken.transfer(reservedContributor1.address, contribution1);
            await seshToken.connect(reservedContributor1).approve(snContribution.getAddress(), contribution1);

            await expect(snContribution.connect(reservedContributor1).contributeFunds(contribution1 - 1, beneficiaryData))
                .to.be.revertedWithCustomError(snContribution, "ContributionBelowReservedAmount");

            const contribution = await snContribution.contributions(reservedContributor1.address);
            expect(contribution).to.equal(0);

            const [remainingReserved, received] = await snContribution.reservedContributions(reservedContributor1.address);
            expect(remainingReserved).to.equal(contribution1);
            expect(received).to.equal(false);
        });

        it("Should allow reserved contributor to contribute more than their reserved funds", async function () {
            await seshToken.transfer(reservedContributor1.address, contribution1 + 1);
            await seshToken.connect(reservedContributor1).approve(snContribution.getAddress(), contribution1 + 1);

            await expect(snContribution.connect(reservedContributor1).contributeFunds(contribution1 + 1, beneficiaryData))
                .to.emit(snContribution, "NewContribution")
                .withArgs(reservedContributor1.address, reservedContributor1.address, contribution1 + 1);

            const contribution = await snContribution.contributions(reservedContributor1.address);
            expect(contribution).to.equal(contribution1 + 1);

            // NOTE: Check reserved slot amount remains at the same amount we
            // initially reserved but is marked received
            {
                const [remainingReserved, received] = await snContribution.reservedContributions(reservedContributor1.address);
                expect(remainingReserved).to.equal(contribution1);
                expect(received).to.equal(true);
            }
        });

        it("Should update minimum contribution based on reserved amounts", async function () {
            const minContribution = await snContribution.minimumContribution();
            const expectedMin = await snContribution.calcMinimumContribution(
                await snContribution.stakingRequirement() - BigInt(ownerContribution + contribution1 + contribution2),
                3,
                await snContribution.maxContributors()
            );
            expect(minContribution).to.equal(expectedMin);
        });

        it("Should not allow other contributors to fill the node past the sum of the reserved and already contributed", async function () {
            const amountToFillNode = await snContribution.stakingRequirement() - BigInt(ownerContribution);
            const [contributor] = await ethers.getSigners();

            await seshToken.transfer(contributor.address, amountToFillNode);
            await seshToken.connect(contributor).approve(snContribution.getAddress(), amountToFillNode);

            await expect(snContribution.connect(contributor).contributeFunds(amountToFillNode, beneficiaryData))
                .to.be.revertedWithCustomError(snContribution, "ContributionExceedsStakingRequirement");
        });

        it("Test withdraw preserves reserved contributor info", async function () {
            // NOTE: Fund reserved contributor 2
            await seshToken.transfer(reservedContributor2.address, contribution2);

            // NOTE: Contribute to the contract
            await seshToken.connect(reservedContributor2).approve(snContribution.getAddress(), contribution2);
            await expect(snContribution.connect(reservedContributor2).contributeFunds(contribution2, beneficiaryData))
                .to.emit(snContribution, "NewContribution")
                .withArgs(reservedContributor2.address, reservedContributor2.address, contribution2);

            // NOTE: Check contract reservation data before we withdraw
            await expect(await snContribution.getReserved()).to.deep.equal(
                [
                    /*Addresses*/ [await snOperator.getAddress(),  await reservedContributor1.getAddress(), await reservedContributor2.getAddress()],
                    /*Amount*/    [ownerContribution,              contribution1,                           contribution2],
                    /*Received*/  [true,                           false,                                   true]
                ]);

            // NOTE: Advance time to permit withdrawal
            await network.provider.send("evm_increaseTime", [60 * 60 * 24]);

            // NOTE: Withdraw
            await withdrawContributor(seshToken, snContribution, reservedContributor2);

            // NOTE: Check contract reservation data after having withdrawn
            await expect(await snContribution.getReserved()).to.deep.equal(
                [
                    /*Addresses*/ [await snOperator.getAddress(),  await reservedContributor1.getAddress(), await reservedContributor2.getAddress()],
                    /*Amount*/    [ownerContribution,              contribution1,                           contribution2],
                    /*Received*/  [true,                           false,                                   false]
                ]);
        })

        it("Test reset processed flushes out reservation data", async function () {
            await expect(await snContribution.getReserved()).to.deep.equal(
                [
                    /*Addresses*/ [await snOperator.getAddress(),  await reservedContributor1.getAddress(), await reservedContributor2.getAddress()],
                    /*Amount*/    [ownerContribution,              contribution1,                           contribution2],
                    /*Received*/  [true,                           false,                                   false]
                ]);
            await snContribution.connect(snOperator).reset();
            await expect(await snContribution.getReserved()).to.deep.equal(
                [
                    /*Addresses*/ [],
                    /*Amount*/    [],
                    /*Received*/  []
                ]);

        });
    });

    describe("Update registration functions", function () {
        let snContribution;
        let snOperator;
        let oldNode = BLS_NODES[0];
        let newNode = BLS_NODES[1];

        beforeEach(async function () {
            [snOperator] = await ethers.getSigners();

            // Deploy the contract
            const node = BLS_NODES[0];
            const tx = await snContributionFactory.connect(snOperator)
                                                  .deploy(oldNode.blsPubkey,
                                                          oldNode.blsSig,
                                                          oldNode.snParams,
                                                          [],
                                                          false /*manualFinalize*/);

            const receipt = await tx.wait();
            const event = getContractEvent(receipt.logs, "NewServiceNodeContributionContract");
            const snContributionAddress = event.args[0];
            snContribution = await ethers.getContractAt("ServiceNodeContribution", snContributionAddress);

            // Contribute operator funds
            const minContribution = await snContribution.minimumContribution();
            await seshToken.transfer(snOperator, TEST_AMNT);
            await seshToken.connect(snOperator).approve(snContributionAddress, minContribution);
        });

        it("Should allow operator to update fee before other contributions", async function () {
            await expect(snContribution.connect(snOperator).updateFee(1n))
                .to.not.be.reverted;

            const params = await snContribution.serviceNodeParams();
            expect(params.serviceNodePubkey).to.equal(oldNode.snParams.serviceNodePubkey);
            expect(params.fee).to.equal(1n);
            expect(params.serviceNodeSignature1).to.deep.equal(oldNode.snParams.serviceNodeSignature1);
            expect(params.serviceNodeSignature2).to.deep.equal(oldNode.snParams.serviceNodeSignature2);
        });

        it("Should allow operator to update pubkeys before other contributions", async function () {
            await expect(snContribution.connect(snOperator)
                                       .updatePubkeys(newNode.blsPubkey,
                                                      newNode.blsSig,
                                                      newNode.snParams.serviceNodePubkey,
                                                      newNode.snParams.serviceNodeSignature1,
                                                      newNode.snParams.serviceNodeSignature2)).to.not.be.reverted;

            const blsPubkey = await snContribution.blsPubkey();
            expect(blsPubkey.X).to.equal(newNode.blsPubkey.X);
            expect(blsPubkey.Y).to.equal(newNode.blsPubkey.Y);

            const params = await snContribution.serviceNodeParams();
            expect(params.serviceNodePubkey).to.equal(newNode.snParams.serviceNodePubkey);
            expect(params.serviceNodeSignature1).to.equal(newNode.snParams.serviceNodeSignature1);
            expect(params.serviceNodeSignature2).to.equal(newNode.snParams.serviceNodeSignature2);
        });

        it("Should fail to update fee after operator contributes", async function () {
            // Contribute
            const minContribution = await snContribution.minimumContribution();
            await seshToken.connect(snOperator).approve(snContribution.target, minContribution);
            await snContribution.connect(snOperator).contributeFunds(minContribution, beneficiaryData);

            await expect(snContribution.connect(snOperator).updateFee(1n))
                .to.be.revertedWithCustomError(snContribution, "RequireWaitForOperatorContribStatus");
        });

        it("Should fail to update pubkeys after another contributor has joined", async function () {
            // Contribute
            const minContribution = await snContribution.minimumContribution();
            await seshToken.connect(snOperator).approve(snContribution.target, minContribution);
            await snContribution.connect(snOperator).contributeFunds(minContribution, beneficiaryData);

            await expect(snContribution.connect(snOperator)
                                       .updatePubkeys(newNode.blsPubkey,
                                                      newNode.blsSig,
                                                      newNode.snParams.serviceNodePubkey,
                                                      newNode.snParams.serviceNodeSignature1,
                                                      newNode.snParams.serviceNodeSignature2))
                .to.be.revertedWithCustomError(snContribution, "RequireWaitForOperatorContribStatus");
        });

        it("Should fail to update fee after contract is finalized", async function () {
            // Finalize the contract
            const stakingRequirement  = await snContribution.stakingRequirement();
            await seshToken.connect(snOperator).approve(snContribution.target, stakingRequirement);
            await snContribution.connect(snOperator).contributeFunds(stakingRequirement, beneficiaryData);
            expect(await snContribution.status()).to.equal(SN_CONTRIB_Status_Finalized);

            // Try to update fee after finalization
            await expect(snContribution.connect(snOperator).updateFee(1n))
                .to.be.revertedWithCustomError(snContribution, "RequireWaitForOperatorContribStatus");
        });

        it("Should fail to update pubkey after contract is finalized", async function () {
            // Finalize the contract
            const stakingRequirement  = await snContribution.stakingRequirement();
            await seshToken.connect(snOperator).approve(snContribution.target, stakingRequirement);
            await snContribution.connect(snOperator).contributeFunds(stakingRequirement, beneficiaryData);
            expect(await snContribution.status()).to.equal(SN_CONTRIB_Status_Finalized);

            // Try to update pubkey after finalization
            await expect(snContribution.connect(snOperator).updatePubkeys(newNode.blsPubkey,
                                                                          newNode.blsSig,
                                                                          newNode.snParams.serviceNodePubkey,
                                                                          newNode.snParams.serviceNodeSignature1,
                                                                          newNode.snParams.serviceNodeSignature2))
                .to.be.revertedWithCustomError(snContribution, "RequireWaitForOperatorContribStatus");
        });

        it("Should update fee after contract reset", async function () {
            // Finalize the contract
            const stakingRequirement  = await snContribution.stakingRequirement();
            await seshToken.connect(snOperator).approve(snContribution.target, stakingRequirement);
            await snContribution.connect(snOperator).contributeFunds(stakingRequirement, beneficiaryData);
            expect(await snContribution.status()).to.equal(SN_CONTRIB_Status_Finalized);

            // Reset the contract
            await snContribution.connect(snOperator).reset();

            // Update params after reset
            await expect(snContribution.connect(snOperator).updateFee(1n))
                .to.not.be.reverted;

            const params = await snContribution.serviceNodeParams();
            expect(params.serviceNodePubkey).to.equal(oldNode.snParams.serviceNodePubkey);
            expect(params.fee).to.equal(1);
            expect(params.serviceNodeSignature1).to.deep.equal(oldNode.snParams.serviceNodeSignature1);
            expect(params.serviceNodeSignature2).to.deep.equal(oldNode.snParams.serviceNodeSignature2);
        });

        it("Should update pubkey after contract reset", async function () {
            // Finalize the contract
            const stakingRequirement  = await snContribution.stakingRequirement();
            await seshToken.connect(snOperator).approve(snContribution.target, stakingRequirement);
            await snContribution.connect(snOperator).contributeFunds(stakingRequirement, beneficiaryData);
            expect(await snContribution.status()).to.equal(SN_CONTRIB_Status_Finalized);


            // Reset the contract
            await snContribution.connect(snOperator).reset();

            // Update pubkey after reset
            await expect(snContribution.connect(snOperator)
                                       .updatePubkeys(newNode.blsPubkey,
                                                      newNode.blsSig,
                                                      newNode.snParams.serviceNodePubkey,
                                                      newNode.snParams.serviceNodeSignature1,
                                                      newNode.snParams.serviceNodeSignature2)).to.not.be.reverted;

            const blsPubkey = await snContribution.blsPubkey();
            expect(blsPubkey.X).to.equal(newNode.blsPubkey.X);
            expect(blsPubkey.Y).to.equal(newNode.blsPubkey.Y);

            const params = await snContribution.serviceNodeParams();
            expect(params.fee).to.equal(0);
            expect(params.serviceNodePubkey).to.equal(newNode.snParams.serviceNodePubkey);
            expect(params.serviceNodeSignature1).to.equal(newNode.snParams.serviceNodeSignature1);
            expect(params.serviceNodeSignature2).to.equal(newNode.snParams.serviceNodeSignature2);
        });
    });
});
