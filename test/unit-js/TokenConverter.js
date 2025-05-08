const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const STAKING_TEST_AMNT = 15000000000000
const TEST_AMNT = 50000000000000

/**
 * Calculates the numerator and denominator for a given rate and token decimals.
 *
 * @param {number} rate - The floating-point conversion rate.
 * @param {number} decimalsA - The number of decimals for token A.
 * @param {number} decimalsB - The number of decimals for token B.
 * @return {Object} An object containing the numerator and denominator.
 */
function calculateFraction(rate, decimalsA, decimalsB) {
  // Determine the scaling factor based on the token decimals
  const scaleFactor = 10000;
  
  // Scale the rate according to the highest decimal place
  const scaledRate = rate * scaleFactor;
  
  // Find the greatest common divisor for scaledRate and scaleFactor
  const gcd = (a, b) => b ? gcd(b, a % b) : a;
  const divisor = gcd(scaleFactor, scaledRate % scaleFactor);
  
  // Simplify the numerator and denominator
  const numerator = BigInt(scaledRate / divisor) * BigInt(10) ** BigInt(decimalsB);
  const denominator = BigInt(scaleFactor / divisor) * BigInt(10) ** BigInt(decimalsA);
  
  return {
    numerator: numerator,
    denominator: denominator
  };
}


describe("TokenConverter Contract Tests", function () {
    const rate = 0.75;
    const rate2 = 2;
    const decimalsTokenA = 18; // WOxen has 18 decimals
    const decimalsTokenB = 9; // SESH to have 9 decimals
    const firstRate = calculateFraction(rate, decimalsTokenA, decimalsTokenB);
    const secondRate = calculateFraction(rate2, decimalsTokenA, decimalsTokenB);
    let TokenAERC20;
    let tokenAERC20;
    let TokenBERC20;
    let tokenBERC20;
    let TokenConverter;
    let tokenConverter;
    let owner;
    let user;
    let testAmount = 1000;
    let bigAtomicTestAmount = ethers.parseUnits(testAmount.toString(), decimalsTokenA);
    let testAmountInContract = testAmount * 10;
    let bigAtomicTestAmountInContract = ethers.parseUnits("10000", decimalsTokenB);

    beforeEach(async function () {
        // Deploy a mock ERC20 token
        try {
            TokenAERC20 = await ethers.getContractFactory("MockWOXEN");
            tokenAERC20 = await TokenAERC20.deploy("WOxen Token", "WOXEN", 100_000_000n * 1_000_000_000_000_000_000n);
        } catch (error) {
            console.error("Error deploying TokenAERC20:", error);
        }
        try {
            TokenBERC20 = await ethers.getContractFactory("MockERC20");
            tokenBERC20 = await TokenBERC20.deploy("SESH Token", "SESH", 240_000_000n * 1_000_000_000n);
        } catch (error) {
            console.error("Error deploying TokenAERC20:", error);
        }

        [owner, user] = await ethers.getSigners();

        TokenConverter = await ethers.getContractFactory("TokenConverter");
        tokenConverter = await TokenConverter.deploy(tokenAERC20, tokenBERC20, firstRate.numerator, firstRate.denominator);

        await tokenAERC20.transfer(user, bigAtomicTestAmount * BigInt(2));
        await tokenAERC20.connect(user).approve(tokenConverter, bigAtomicTestAmount * BigInt(2));

    });

    it("Should deploy and set the correct owner", async function () {
        expect(await tokenConverter.owner()).to.equal(owner.address);
    });

    it("Should have correct converstion rate", async function () {
        expect(await tokenConverter.conversionRateNumerator()).to.equal(firstRate.numerator);
        expect(await tokenConverter.conversionRateDenominator()).to.equal(firstRate.denominator);
    });

    it("Should be able to deposit to it", async function () {
        await tokenBERC20.approve(tokenConverter, bigAtomicTestAmountInContract);
        await tokenConverter.depositTokenB(bigAtomicTestAmountInContract);
        expect(await tokenBERC20.balanceOf(tokenConverter)).to.equal(bigAtomicTestAmountInContract);
    });
    it("Should be able to change conversion rate", async function () {
        await tokenConverter.updateConversionRate(secondRate.numerator, secondRate.denominator);
        expect(await tokenConverter.conversionRateNumerator()).to.equal(secondRate.numerator);
        expect(await tokenConverter.conversionRateDenominator()).to.equal(secondRate.denominator);
    });
    
    describe("After seeding converter contract with funds", function () {
        beforeEach(async function () {
            let testAmountInContract = ethers.parseUnits("10000", decimalsTokenB);
            await tokenBERC20.approve(tokenConverter, bigAtomicTestAmountInContract);
            await tokenConverter.depositTokenB(bigAtomicTestAmountInContract)
        });

        it("Should be able to convert funds", async function () {
            await tokenConverter.connect(user).convertTokens(bigAtomicTestAmount);
            expect(await tokenBERC20.balanceOf(user)).to.equal(ethers.parseUnits((testAmount * rate).toString(), decimalsTokenB));
        });

        it("Should be able to convert funds, change rate and convert again", async function () {
            await tokenConverter.connect(user).convertTokens(bigAtomicTestAmount);
            expect(await tokenBERC20.balanceOf(user)).to.equal(ethers.parseUnits((testAmount * rate).toString(), decimalsTokenB));
            await tokenConverter.updateConversionRate(secondRate.numerator, secondRate.denominator);
            await tokenConverter.connect(user).convertTokens(bigAtomicTestAmount);
            expect(await tokenBERC20.balanceOf(user)).to.equal(ethers.parseUnits((testAmount * (rate + rate2)).toString(), decimalsTokenB));
        });

        it("Should collect tokenA from the user and send tokenB at the specified rate", async function () {
            // Get initial balances
            const initialTokenABalance = await tokenAERC20.balanceOf(user.address);
            const initialTokenBBalance = await tokenBERC20.balanceOf(user.address);

            // Perform conversion
            await tokenConverter.connect(user).convertTokens(bigAtomicTestAmount);

            // Calculate amount of tokenB to be received
            const amountB = bigAtomicTestAmount * firstRate.numerator / firstRate.denominator;

            // Get final balances
            const finalTokenABalance = await tokenAERC20.balanceOf(user.address);
            const finalTokenBBalance = await tokenBERC20.balanceOf(user.address);

            // Check that tokenA was deducted from user balance
            expect(finalTokenABalance).to.equal(initialTokenABalance - bigAtomicTestAmount);

            // Check that tokenB was added to user balance
            expect(finalTokenBBalance).to.equal(initialTokenBBalance + amountB);
        });

        it("Should revert if _amountA is zero", async function () {
            await expect(tokenConverter.connect(user).convertTokens(0))
                .to.be.revertedWith("Amount must be greater than 0");
        });

        it("Should revert if the user does not have enough tokenA for _amountA", async function () {
            // Attempt to convert more than the user's balance
            const userBalance = await tokenAERC20.balanceOf(user.address);
            const amountToConvert = userBalance + ethers.parseUnits("1", decimalsTokenA);

            await expect(tokenConverter.connect(user).convertTokens(amountToConvert))
                .to.be.revertedWithCustomError(tokenAERC20, "ERC20InsufficientAllowance")
        });

        it("Should revert if the contract does not have enough tokenB for the converted amount", async function () {
            // Withdraw all tokenB from the contract
            const contractTokenBBalance = await tokenBERC20.balanceOf(tokenConverter.getAddress());
            await tokenConverter.withdrawTokenB(contractTokenBBalance);

            // Attempt conversion
            await expect(tokenConverter.connect(user).convertTokens(bigAtomicTestAmount))
                .to.be.revertedWith("Insufficient Token B in contract");
        });
    });

    describe("Pausable functionality", function () {
        beforeEach(async function () {
            // Ensure contract is seeded with TokenB for conversion tests
            let testAmountInContract = ethers.parseUnits("10000", decimalsTokenB);
            await tokenBERC20.approve(tokenConverter, bigAtomicTestAmountInContract);
            await tokenConverter.depositTokenB(bigAtomicTestAmountInContract);
        });

        it("Should allow owner to pause and unpause", async function () {
            expect(await tokenConverter.paused()).to.be.false;
            await expect(tokenConverter.connect(owner).pause())
                .to.emit(tokenConverter, "Paused")
                .withArgs(owner.address);
            expect(await tokenConverter.paused()).to.be.true;
            await expect(tokenConverter.connect(owner).unpause())
                .to.emit(tokenConverter, "Unpaused")
                .withArgs(owner.address);
            expect(await tokenConverter.paused()).to.be.false;
        });

        it("Should not allow non-owner to pause or unpause", async function () {
            await expect(tokenConverter.connect(user).pause())
                .to.be.revertedWithCustomError(tokenConverter, "OwnableUnauthorizedAccount")
                .withArgs(user.address);
            await expect(tokenConverter.connect(user).unpause())
                .to.be.revertedWithCustomError(tokenConverter, "OwnableUnauthorizedAccount")
                .withArgs(user.address);
        });

        it("convertTokens should revert when paused", async function () {
            await tokenConverter.connect(owner).pause(); // Pause the contract
            expect(await tokenConverter.paused()).to.be.true;
            await expect(tokenConverter.connect(user).convertTokens(bigAtomicTestAmount))
                .to.be.revertedWithCustomError(tokenConverter, "EnforcedPause");
        });

        it("convertTokens should work when unpaused", async function () {
            await tokenConverter.connect(owner).pause(); // Pause
            expect(await tokenConverter.paused()).to.be.true;
            await tokenConverter.connect(owner).unpause(); // Unpause
            expect(await tokenConverter.paused()).to.be.false;

            const initialTokenBBalance = await tokenBERC20.balanceOf(user.address);
            await tokenConverter.connect(user).convertTokens(bigAtomicTestAmount);
            const amountB = bigAtomicTestAmount * firstRate.numerator / firstRate.denominator;
            expect(await tokenBERC20.balanceOf(user.address)).to.equal(initialTokenBBalance + amountB);
        });

        it("depositTokenB should still work when paused", async function () {
            await tokenConverter.connect(owner).pause(); // Pause the contract
            expect(await tokenConverter.paused()).to.be.true;

            const depositAmount = ethers.parseUnits("100", decimalsTokenB);
            const initialContractTokenBBalance = await tokenBERC20.balanceOf(tokenConverter.getAddress());
            
            await tokenBERC20.connect(owner).approve(tokenConverter.getAddress(), depositAmount);
            await expect(tokenConverter.connect(owner).depositTokenB(depositAmount)).to.not.be.reverted;
            
            expect(await tokenBERC20.balanceOf(tokenConverter.getAddress())).to.equal(initialContractTokenBBalance + depositAmount);
        });
        
        it("withdrawTokenB should still work when paused", async function () {
            // Deposit some tokens first to withdraw
            const depositAmount = ethers.parseUnits("100", decimalsTokenB);
            await tokenBERC20.connect(owner).approve(tokenConverter.getAddress(), depositAmount);
            await tokenConverter.connect(owner).depositTokenB(depositAmount);
            const initialOwnerTokenBBalance = await tokenBERC20.balanceOf(owner.address);

            await tokenConverter.connect(owner).pause(); // Pause the contract
            expect(await tokenConverter.paused()).to.be.true;
            
            await expect(tokenConverter.connect(owner).withdrawTokenB(depositAmount)).to.not.be.reverted;
            expect(await tokenBERC20.balanceOf(owner.address)).to.equal(initialOwnerTokenBBalance + depositAmount);
        });
    });
});
