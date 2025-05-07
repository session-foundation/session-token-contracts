const {
  loadFixture,
  time,
} = require('@nomicfoundation/hardhat-toolbox/network-helpers');
const { expect } = require('chai');
const { ethers } = require('hardhat');
const { anyValue } = require("@nomicfoundation/hardhat-chai-matchers/withArgs");

// Helper function to calculate name hash (token ID)
function calculateNameHash(name) {
  return ethers.keccak256(ethers.toUtf8Bytes(name));
}

describe('SessionNameService', function () {
  const BASE_URI = 'https://api.example.com/sns/';
  const TEST_NAME_1 = 'alice';
  const TEST_NAME_2 = 'bob';
  const TEST_NAME_INVALID_CHARS = 'charlie!';
  const TEST_NAME_UPPER = 'ALICE'; // For case-insensitivity check
  const TEST_NAME_MIXED = 'Alice';
  const TEST_NAME_WITH_PLUS = 'name+plus';
  const TEST_NAME_WITH_SLASH = 'name/slash';
  const TEST_NAME_WITH_EQUALS = 'name=='; // Example Base64 padding
  const TEST_NAME_WITH_NUMBERS = 'name123';
  const TEST_NAME_INVALID_SPACE = 'name space';
  const TEST_NAME_INVALID_DASH = 'name-dash';
  const TEST_NAME_INVALID_UNICODE = '你好';

  const INITIAL_EXPIRATION_DAYS = 365;
  const ONE_DAY = 24 * 60 * 60;
  const THIRTY_DAYS = 30 * ONE_DAY;
  const YEAR_PLUS_ONE_DAY = (INITIAL_EXPIRATION_DAYS + 1) * ONE_DAY;
  
  // Record types
  const SESSION_RECORD_TYPE = 1;
  const LOKINET_RECORD_TYPE = 3;

  // Fee-related constants
  const REGISTRATION_FEE = ethers.parseUnits("1.0", 9);
  const TRANSFER_FEE = ethers.parseUnits("0.5", 9);

  async function deploySessionNameServiceFixture() {
    const [owner, registerer, user1, user2, otherAccount] =
      await ethers.getSigners();

    // Deploy mock ERC20 token for testing
    const MockToken = await ethers.getContractFactory("MockERC20");
    const mockToken = await MockToken.deploy("Mock Token", "MTK", ethers.parseUnits("1000000", 9));
    await mockToken.waitForDeployment();

    const SessionNameServiceFactory = await ethers.getContractFactory(
      'SessionNameService'
    );
    const sns = await SessionNameServiceFactory.deploy(BASE_URI);
    await sns.waitForDeployment();

    // Grant REGISTERER_ROLE to the 'registerer' account
    const REGISTERER_ROLE = await sns.REGISTERER_ROLE();
    await sns.connect(owner).grantRole(REGISTERER_ROLE, registerer.address);

    // Set up payment token and fees
    await sns.connect(owner).setPaymentToken(await mockToken.getAddress());
    await sns.connect(owner).setFees(REGISTRATION_FEE, TRANSFER_FEE);

    // Mint tokens to users for testing
    await mockToken.transfer(owner.address, ethers.parseUnits("1000", 9));
    await mockToken.transfer(registerer.address, ethers.parseUnits("1000", 9));
    await mockToken.transfer(user1.address, ethers.parseUnits("1000", 9));
    await mockToken.transfer(user2.address, ethers.parseUnits("1000", 9));

    // Approve tokens for the contract
    await mockToken.connect(owner).approve(await sns.getAddress(), ethers.parseUnits("1000", 9));
    await mockToken.connect(registerer).approve(await sns.getAddress(), ethers.parseUnits("1000", 9));
    await mockToken.connect(user1).approve(await sns.getAddress(), ethers.parseUnits("1000", 9));
    await mockToken.connect(user2).approve(await sns.getAddress(), ethers.parseUnits("1000", 9));

    return {
      sns,
      mockToken,
      owner,
      registerer,
      user1,
      user2,
      otherAccount,
      REGISTERER_ROLE,
    };
  }

  // --- Deployment and Initialization ---
  describe('Deployment', function () {
    it('Should set the correct ERC721 name and symbol', async function () {
      const { sns } = await loadFixture(deploySessionNameServiceFixture);
      expect(await sns.name()).to.equal('SessionNameService');
      expect(await sns.symbol()).to.equal('SNS');
    });

    it('Should set the correct baseTokenURI', async function () {
      const { sns } = await loadFixture(deploySessionNameServiceFixture);
      expect(await sns.baseTokenURI()).to.equal(BASE_URI);
    });

    it('Should grant DEFAULT_ADMIN_ROLE to the deployer', async function () {
      const { sns, owner } = await loadFixture(deploySessionNameServiceFixture);
      const ADMIN_ROLE = await sns.DEFAULT_ADMIN_ROLE();
      expect(await sns.hasRole(ADMIN_ROLE, owner.address)).to.be.true;
    });

    it('Should initialize totalSupply to 0', async function () {
      const { sns } = await loadFixture(deploySessionNameServiceFixture);
      expect(await sns.totalSupply()).to.equal(0);
    });

    it('Should initialize expiration correctly', async function () {
      const { sns } = await loadFixture(deploySessionNameServiceFixture);
      expect(await sns.expiration()).to.equal(INITIAL_EXPIRATION_DAYS * ONE_DAY);
    });

    it('Should initialize allowRenewals to false', async function () {
      const { sns } = await loadFixture(deploySessionNameServiceFixture);
      expect(await sns.allowRenewals()).to.be.false;
    });
  });

  // --- Access Control ---
  describe('Access Control', function () {
    it('DEFAULT_ADMIN_ROLE can grant REGISTERER_ROLE', async function () {
      const { sns, owner, otherAccount, REGISTERER_ROLE } = await loadFixture(
        deploySessionNameServiceFixture
      );
      await expect(sns.connect(owner).grantRole(REGISTERER_ROLE, otherAccount.address))
        .to.not.be.reverted;
      expect(await sns.hasRole(REGISTERER_ROLE, otherAccount.address)).to.be.true;
    });

    it('Non-admin cannot grant REGISTERER_ROLE', async function () {
      const { sns, otherAccount, user1, REGISTERER_ROLE } = await loadFixture(
        deploySessionNameServiceFixture
      );
      await expect(
        sns.connect(otherAccount).grantRole(REGISTERER_ROLE, user1.address)
      ).to.be.revertedWithCustomError(sns, 'AccessControlUnauthorizedAccount');
    });

    it('DEFAULT_ADMIN_ROLE can revoke REGISTERER_ROLE', async function () {
        const { sns, owner, registerer, REGISTERER_ROLE } = await loadFixture(deploySessionNameServiceFixture);
        await sns.connect(owner).revokeRole(REGISTERER_ROLE, registerer.address);
        expect(await sns.hasRole(REGISTERER_ROLE, registerer.address)).to.be.false;
    });

    it('Only REGISTERER_ROLE or ADMIN_ROLE can call registerName', async function () {
      const { sns, registerer, owner, user1, user2, otherAccount } = await loadFixture(
        deploySessionNameServiceFixture
      );

      await expect(sns.connect(registerer).registerName(user1.address, TEST_NAME_1))
        .to.not.be.reverted;
        
      await expect(sns.connect(owner).registerName(user2.address, TEST_NAME_2))
        .to.not.be.reverted;
        
      await expect(
        sns.connect(otherAccount).registerName(otherAccount.address, 'failname')
      ).to.be.revertedWithCustomError(sns, 'NotAuthorized');
    });

     it('Only REGISTERER_ROLE or ADMIN_ROLE can call expireName', async function () {
        const { sns, owner, registerer, user1, otherAccount } = await loadFixture(deploySessionNameServiceFixture);

        await sns.connect(owner).flipRenewals();
        await sns.connect(registerer).registerName(user1.address, TEST_NAME_1);

        await time.increase(YEAR_PLUS_ONE_DAY);

        await expect(sns.connect(otherAccount).expireName(TEST_NAME_1))
              .to.be.revertedWithCustomError(sns, 'NotAuthorized');
              
        await expect(sns.connect(user1).expireName(TEST_NAME_1))
              .to.be.revertedWithCustomError(sns, 'NotAuthorized');
              
        await expect(sns.connect(registerer).expireName(TEST_NAME_1)).to.not.be.reverted;

        await sns.connect(registerer).registerName(user1.address, TEST_NAME_2);
        await time.increase(YEAR_PLUS_ONE_DAY);
        
        await expect(sns.connect(owner).expireName(TEST_NAME_2)).to.not.be.reverted;
     });

    it('Only ADMIN_ROLE can call setBaseTokenURI', async function () {
      const { sns, owner, otherAccount } = await loadFixture(
        deploySessionNameServiceFixture
      );
      const newURI = 'ipfs://newcid/';
      await expect(sns.connect(owner).setBaseTokenURI(newURI)).to.not.be.reverted;
      expect(await sns.baseTokenURI()).to.equal(newURI);
      await expect(
        sns.connect(otherAccount).setBaseTokenURI('ipfs://fail/')
      ).to.be.revertedWithCustomError(sns, 'AccessControlUnauthorizedAccount');
    });

    it('Only ADMIN_ROLE can call flipRenewals', async function () {
      const { sns, owner, otherAccount } = await loadFixture(
        deploySessionNameServiceFixture
      );
      await expect(sns.connect(owner).flipRenewals()).to.not.be.reverted;
      expect(await sns.allowRenewals()).to.be.true;
      await expect(sns.connect(otherAccount).flipRenewals())
        .to.be.revertedWithCustomError(sns, 'AccessControlUnauthorizedAccount');
    });

     it('Only ADMIN_ROLE can call setExpirationDuration', async function () {
        const { sns, owner, otherAccount } = await loadFixture(deploySessionNameServiceFixture);
        const validDuration = BigInt(60 * ONE_DAY); // 60 days (valid)
        const tooShortDuration = BigInt(10 * ONE_DAY); // 10 days (invalid, < 30 days)
        const tooLongDuration = BigInt(101 * 365 * ONE_DAY); // 101 years (invalid, > 100 years)

        await expect(sns.connect(owner).setExpirationDuration(validDuration)).to.not.be.reverted;
        expect(await sns.expiration()).to.equal(validDuration);

        await expect(
          sns.connect(otherAccount).setExpirationDuration(validDuration)
        ).to.be.revertedWithCustomError(sns, 'AccessControlUnauthorizedAccount');

        await expect(
            sns.connect(owner).setExpirationDuration(tooShortDuration)
        ).to.be.revertedWithCustomError(sns, 'InvalidExpirationDuration');

        await expect(
            sns.connect(owner).setExpirationDuration(tooLongDuration)
        ).to.be.revertedWithCustomError(sns, 'ExpirationDurationTooLong');
    });
  });

  // --- Name Registration ---
  describe('Name Registration (registerName)', function () {
    it('Should allow REGISTERER_ROLE to register a name', async function () {
      const { sns, registerer, user1 } = await loadFixture(
        deploySessionNameServiceFixture
      );
      const tokenId = calculateNameHash(TEST_NAME_1);
      await expect(sns.connect(registerer).registerName(user1.address, TEST_NAME_1))
        .to.emit(sns, 'NameRegistered')
        .withArgs(TEST_NAME_1, user1.address, tokenId);

      expect(await sns.ownerOf(tokenId)).to.equal(user1.address);
      expect(await sns.resolve(TEST_NAME_1, SESSION_RECORD_TYPE)).to.equal("");
      expect(await sns.balanceOf(user1.address)).to.equal(1);
      expect(await sns.totalSupply()).to.equal(1);
      
      const asset = await sns.namesToAssets(TEST_NAME_1);
      expect(asset.id).to.equal(tokenId);
      const linkedName = await sns.idsToNames(tokenId);
      expect(linkedName).to.equal(TEST_NAME_1);
    });

    it('Should handle case-sensitivity on registration', async function () {
      const { sns, registerer, user1, user2 } = await loadFixture(
        deploySessionNameServiceFixture
      );
      const nameLower = TEST_NAME_1;   // "alice"
      const nameUpper = TEST_NAME_UPPER; // "ALICE"
      const nameMixed = TEST_NAME_MIXED; // "Alice"
      const tokenIdLower = calculateNameHash(nameLower);
      const tokenIdUpper = calculateNameHash(nameUpper);
      const tokenIdMixed = calculateNameHash(nameMixed);

      // Register lowercase
      await expect(sns.connect(registerer).registerName(user1.address, nameLower))
        .to.emit(sns, 'NameRegistered')
        .withArgs(nameLower, user1.address, tokenIdLower);
      expect(await sns.ownerOf(tokenIdLower)).to.equal(user1.address);
      expect(await sns.totalSupply()).to.equal(1);

      // Register uppercase - should succeed as it's a different name
      await expect(sns.connect(registerer).registerName(user2.address, nameUpper))
        .to.emit(sns, 'NameRegistered')
        .withArgs(nameUpper, user2.address, tokenIdUpper);
      expect(await sns.ownerOf(tokenIdUpper)).to.equal(user2.address);
      expect(await sns.totalSupply()).to.equal(2);

      // Register mixed case - should succeed
      await expect(sns.connect(registerer).registerName(user1.address, nameMixed))
          .to.emit(sns, 'NameRegistered')
          .withArgs(nameMixed, user1.address, tokenIdMixed);
      expect(await sns.ownerOf(tokenIdMixed)).to.equal(user1.address);
      expect(await sns.totalSupply()).to.equal(3);

      // Check resolution is case-sensitive
      expect(await sns.resolve(nameLower, SESSION_RECORD_TYPE)).to.equal("");
      expect(await sns.resolve(nameUpper, SESSION_RECORD_TYPE)).to.equal("");
      expect(await sns.resolve(nameMixed, SESSION_RECORD_TYPE)).to.equal("");

      // Check internal storage preserves case
      const assetLower = await sns.namesToAssets(nameLower);
      expect(assetLower.id).to.equal(tokenIdLower);
      const linkedLower = await sns.idsToNames(tokenIdLower);
      expect(linkedLower).to.equal(nameLower);

      const assetUpper = await sns.namesToAssets(nameUpper);
      expect(assetUpper.id).to.equal(tokenIdUpper);
      const linkedUpper = await sns.idsToNames(tokenIdUpper);
      expect(linkedUpper).to.equal(nameUpper);

      const assetMixed = await sns.namesToAssets(nameMixed);
      expect(assetMixed.id).to.equal(tokenIdMixed);
      const linkedMixed = await sns.idsToNames(tokenIdMixed);
      expect(linkedMixed).to.equal(nameMixed);
    });

    it('Should revert if registering an empty name', async function () {
      const { sns, registerer, user1 } = await loadFixture(
        deploySessionNameServiceFixture
      );
      await expect(
        sns.connect(registerer).registerName(user1.address, '')
      ).to.be.revertedWithCustomError(sns, 'NullName');
    });

    it('Should register names with valid Base64 characters', async function () {
        const { sns, registerer, user1 } = await loadFixture(deploySessionNameServiceFixture);
        await expect(sns.connect(registerer).registerName(user1.address, TEST_NAME_WITH_PLUS)).to.not.be.reverted;
        await expect(sns.connect(registerer).registerName(user1.address, TEST_NAME_WITH_SLASH)).to.not.be.reverted;
        await expect(sns.connect(registerer).registerName(user1.address, TEST_NAME_WITH_EQUALS)).to.not.be.reverted;
        await expect(sns.connect(registerer).registerName(user1.address, TEST_NAME_WITH_NUMBERS)).to.not.be.reverted;
        await expect(sns.connect(registerer).registerName(user1.address, TEST_NAME_UPPER)).to.not.be.reverted;
    });

    it('Should revert if registering a name with invalid characters', async function () {
      const { sns, registerer, user1 } = await loadFixture(
        deploySessionNameServiceFixture
      );
      await expect(
        sns.connect(registerer).registerName(user1.address, TEST_NAME_INVALID_CHARS) // charlie!
      ).to.be.revertedWithCustomError(sns, 'UnsupportedCharacters');
      await expect(
        sns.connect(registerer).registerName(user1.address, TEST_NAME_INVALID_SPACE) // "with space"
      ).to.be.revertedWithCustomError(sns, 'UnsupportedCharacters');
      await expect(
        sns.connect(registerer).registerName(user1.address, TEST_NAME_INVALID_DASH) // "with-dash"
      ).to.be.revertedWithCustomError(sns, 'UnsupportedCharacters');
       await expect(
        sns.connect(registerer).registerName(user1.address, TEST_NAME_INVALID_UNICODE) // "你好"
      ).to.be.revertedWithCustomError(sns, 'UnsupportedCharacters');
    });

    it('Should revert if registering a name that is already registered (case-sensitive)', async function () {
      const { sns, registerer, user1, user2 } = await loadFixture(
        deploySessionNameServiceFixture
      );
      // Register lowercase
      await sns.connect(registerer).registerName(user1.address, TEST_NAME_1);
      // Attempt to re-register exact same name - should fail
      await expect(
        sns.connect(registerer).registerName(user2.address, TEST_NAME_1)
      ).to.be.revertedWithCustomError(sns, 'NameAlreadyRegistered');

      // Attempt to register uppercase version - should succeed now
      await expect(
        sns.connect(registerer).registerName(user2.address, TEST_NAME_UPPER)
      ).to.not.be.reverted;
    });

    it('Should return the correct token ID on successful registration', async function () {
        const { sns, registerer, user1 } = await loadFixture(deploySessionNameServiceFixture);
        const name = TEST_NAME_1;
        const expectedTokenId = calculateNameHash(name);
        const returnedTokenId = await sns.connect(registerer).registerName.staticCall(user1.address, name);
        expect(returnedTokenId).to.equal(expectedTokenId);
    });

    it('Cannot register without sufficient token balance', async function () {
      const { sns, registerer, user1, mockToken } = await loadFixture(deploySessionNameServiceFixture);
      
      // Set allowance to 0 to simulate insufficient balance
      await mockToken.connect(user1).approve(await sns.getAddress(), 0);
      
      await expect(
        sns.connect(registerer).registerName(user1.address, TEST_NAME_1)
      ).to.be.revertedWithCustomError(mockToken, 'ERC20InsufficientAllowance')
      .withArgs(await sns.getAddress(), 0, REGISTRATION_FEE);
    });
  });

  // --- Name Resolution ---
  describe('Name Resolution (`resolve`)', function () {
    it('Should resolve a registered name to its owner', async function () {
      const { sns, registerer, user1 } = await loadFixture(
        deploySessionNameServiceFixture
      );
      await sns.connect(registerer).registerName(user1.address, TEST_NAME_1);
      expect(await sns.resolve(TEST_NAME_1, SESSION_RECORD_TYPE)).to.equal("");
      expect(await sns.resolve(TEST_NAME_1, LOKINET_RECORD_TYPE)).to.equal("");
    });

    it('Should return empty string for a name with different casing if not registered', async function () {
      const { sns, registerer, user1 } = await loadFixture(
        deploySessionNameServiceFixture
      );
      // Register lowercase 'alice'
      await sns.connect(registerer).registerName(user1.address, TEST_NAME_1);
      // Try resolving uppercase 'ALICE' - should revert with NameNotRegistered
      await expect(sns.resolve(TEST_NAME_UPPER, SESSION_RECORD_TYPE))
        .to.be.revertedWithCustomError(sns, 'NameNotRegistered');
      await expect(sns.resolve(TEST_NAME_MIXED, SESSION_RECORD_TYPE))
        .to.be.revertedWithCustomError(sns, 'NameNotRegistered');
    });

    it('Should revert with NameNotRegistered for an unregistered name', async function () {
      const { sns } = await loadFixture(deploySessionNameServiceFixture);
      await expect(sns.resolve('nonexistent', SESSION_RECORD_TYPE))
        .to.be.revertedWithCustomError(sns, 'NameNotRegistered');
      await expect(sns.resolve('nonexistent', LOKINET_RECORD_TYPE))
        .to.be.revertedWithCustomError(sns, 'NameNotRegistered');
    });

    it('Should revert with NameNotRegistered after a name is burned', async function () {
      const { sns, registerer, user1 } = await loadFixture(deploySessionNameServiceFixture);
      const name = TEST_NAME_1;
      await sns.connect(registerer).registerName(user1.address, name);
      const tokenId = calculateNameHash(name);
      expect(await sns.resolve(name, SESSION_RECORD_TYPE)).to.equal("");

      await sns.connect(user1).burn(tokenId);

      await expect(sns.resolve(name, SESSION_RECORD_TYPE))
        .to.be.revertedWithCustomError(sns, 'NameNotRegistered');
      await expect(sns.resolve(name, LOKINET_RECORD_TYPE))
        .to.be.revertedWithCustomError(sns, 'NameNotRegistered');
    });

    it('Should return empty string for invalid record type', async function () {
      const { sns, registerer, user1 } = await loadFixture(deploySessionNameServiceFixture);
      await sns.connect(registerer).registerName(user1.address, TEST_NAME_1);
      
      // Try with invalid record type (2 is unused)
      expect(await sns.resolve(TEST_NAME_1, 2)).to.equal("");
      
      // Try with another invalid record type
      expect(await sns.resolve(TEST_NAME_1, 4)).to.equal("");
    });

    it('Should resolve session and lokinet names separately', async function () {
      const { sns, registerer, user1 } = await loadFixture(deploySessionNameServiceFixture);
      const name = TEST_NAME_1;
      await sns.connect(registerer).registerName(user1.address, name);
      const tokenId = calculateNameHash(name);
      
      const sessionText = "session.name.record";
      const lokinetText = "lokinet.address.record";
      
      // Set different record types
      await sns.connect(user1).setTextRecord(tokenId, SESSION_RECORD_TYPE, sessionText);
      await sns.connect(user1).setTextRecord(tokenId, LOKINET_RECORD_TYPE, lokinetText);
      
      // Verify they're resolved separately
      expect(await sns.resolve(name, SESSION_RECORD_TYPE)).to.equal(sessionText);
      expect(await sns.resolve(name, LOKINET_RECORD_TYPE)).to.equal(lokinetText);
    });
  });

  // --- Renewals and Expiration ---
  describe('Renewals and Expiration', function () {
    let sns, owner, registerer, user1, user2, otherAccount, name, tokenId;
    const expirationPeriod = INITIAL_EXPIRATION_DAYS * ONE_DAY;

    beforeEach(async function () {
      const fixtureData = await loadFixture(deploySessionNameServiceFixture);
      sns = fixtureData.sns;
      owner = fixtureData.owner;
      registerer = fixtureData.registerer;
      user1 = fixtureData.user1;
      user2 = fixtureData.user2;
      otherAccount = fixtureData.otherAccount;

      name = TEST_NAME_1;
      await sns.connect(owner).flipRenewals();
      expect(await sns.allowRenewals()).to.be.true;

      await sns.connect(registerer).registerName(user1.address, name);
      tokenId = calculateNameHash(name);
    });

    describe('`renewName`', function () {
       it('Should allow the owner to renew their name', async function () {
        const initialAsset = await sns.namesToAssets(name);
        const initialTimestamp = initialAsset.renewals;

        await time.increase(ONE_DAY * 10);
        const expectedTimestamp = initialTimestamp + BigInt(expirationPeriod);

        await expect(sns.connect(user1).renewName(name))
          .to.emit(sns, 'NameRenewed')
          .withArgs(name, user1.address, anyValue);

        const renewedAsset = await sns.namesToAssets(name);
        expect(renewedAsset.renewals).to.be.gt(initialTimestamp);
        expect(renewedAsset.renewals).to.be.closeTo(expectedTimestamp, 2);
      });

      it('Should revert if called by someone other than the owner', async function () {
        await expect(sns.connect(otherAccount).renewName(name))
          .to.be.revertedWithCustomError(sns, 'ERC721IncorrectOwner')
          .withArgs(otherAccount.address, tokenId, user1.address);
      });

      it('Should revert if renewals are disabled', async function () {
        await sns.connect(owner).flipRenewals();
        expect(await sns.allowRenewals()).to.be.false;

        await expect(sns.connect(user1).renewName(name))
            .to.be.revertedWithCustomError(sns, 'RenewalsDisabled');
      });

      it('Should revert if the name is not registered', async function () {
        await expect(sns.connect(user1).renewName('nonexistent'))
          .to.be.revertedWithCustomError(sns, 'NameNotRegistered');
      });

      it('Should revert renewal if name casing does not match owned name', async function () {
          // User1 owns 'alice' (TEST_NAME_1)
          await time.increase(ONE_DAY * 5);

          // Try to renew 'ALICE' (TEST_NAME_UPPER) - should fail as user1 doesn't own it
          await expect(sns.connect(user1).renewName(TEST_NAME_UPPER))
              .to.be.revertedWithCustomError(sns, 'NameNotRegistered');

          // Try to renew 'Alice' (TEST_NAME_MIXED) - should fail
           await expect(sns.connect(user1).renewName(TEST_NAME_MIXED))
              .to.be.revertedWithCustomError(sns, 'NameNotRegistered');
      });
    });

    describe('`expireName`', function () {
        it('Should allow REGISTERER to expire a name after the expiration period', async function () {
            const initialAsset = await sns.namesToAssets(name);
            const renewalTimestamp = initialAsset.renewals;
            const expireTime = Number(renewalTimestamp) + expirationPeriod;

            await time.increaseTo(expireTime + 1);

            await expect(sns.connect(registerer).expireName(name))
                .to.emit(sns, 'NameExpired')
                .withArgs(name, user1.address, tokenId);

            await expect(sns.ownerOf(tokenId)).to.be.revertedWithCustomError(sns, 'ERC721NonexistentToken');
        });

         it('Should allow ADMIN to expire a name after the expiration period', async function () {
            const initialAsset = await sns.namesToAssets(name);
            const renewalTimestamp = initialAsset.renewals;
            const expireTime = Number(renewalTimestamp) + expirationPeriod;

            await time.increaseTo(expireTime + 1);

            await expect(sns.connect(owner).expireName(name))
                .to.emit(sns, 'NameExpired')
                .withArgs(name, user1.address, tokenId);

            await expect(sns.ownerOf(tokenId)).to.be.reverted;
        });

        it('Should revert if trying to expire before the expiration period', async function () {
            const initialAsset = await sns.namesToAssets(name);
            const renewalTimestamp = initialAsset.renewals;
            const expireTime = Number(renewalTimestamp) + expirationPeriod;

            await time.increaseTo(expireTime - ONE_DAY);

            await expect(sns.connect(registerer).expireName(name))
                .to.be.revertedWithCustomError(sns, 'RenewalPeriodNotOver');
        });

        it('Should revert if renewals are disabled', async function () {
            await sns.connect(owner).flipRenewals();
            expect(await sns.allowRenewals()).to.be.false;

            await time.increase(YEAR_PLUS_ONE_DAY);

             await expect(sns.connect(registerer).expireName(name))
                .to.be.revertedWithCustomError(sns, 'RenewalsDisabled');
        });

         it('Should revert if the name is not registered', async function () {
            await time.increase(YEAR_PLUS_ONE_DAY);
            await expect(sns.connect(registerer).expireName('nonexistent'))
                .to.be.revertedWithCustomError(sns, 'NameNotRegistered');
         });

         it('Should revert expiration if name casing does not match existing name', async function () {
            // 'alice' (TEST_NAME_1) is registered
            const initialAsset = await sns.namesToAssets(name);
            const renewalTimestamp = initialAsset.renewals;
            const expireTime = Number(renewalTimestamp) + expirationPeriod;

            await time.increaseTo(expireTime + 1);

            // Try to expire 'ALICE' - should fail
            await expect(sns.connect(registerer).expireName(TEST_NAME_UPPER))
                .to.be.revertedWithCustomError(sns, 'NameNotRegistered');

            // Try to expire 'Alice' - should fail
             await expect(sns.connect(registerer).expireName(TEST_NAME_MIXED))
                .to.be.revertedWithCustomError(sns, 'NameNotRegistered');
         });

        it('Should correctly handle expiration after renewal', async function () {
            // 1. Register: timestamp T0
            const initialAsset = await sns.namesToAssets(name);
            const t0 = initialAsset.renewals;

            // 2. Advance time by 100 days (T0 + 100d)
            await time.increase(100 * ONE_DAY);

            // 3. Renew: timestamp T1 = T0 + 100d
            await sns.connect(user1).renewName(name);
            const renewedAsset = await sns.namesToAssets(name);
            const t1 = renewedAsset.renewals;
            expect(t1).to.be.gt(t0);

            // 4. Calculate new expiration time: T1 + expirationPeriod
            const newExpireTime = Number(t1) + expirationPeriod;

            // 5. Try to expire based on old time (should fail)
            const oldExpireTime = Number(t0) + expirationPeriod;
            await time.increaseTo(oldExpireTime + 1);
            await expect(sns.connect(registerer).expireName(name))
                .to.be.revertedWithCustomError(sns, 'RenewalPeriodNotOver');

            // 6. Advance past new expiration time (T1 + expirationPeriod + 1)
            await time.increaseTo(newExpireTime + 1);

            // 7. Expire (should succeed)
            await expect(sns.connect(registerer).expireName(name))
                .to.emit(sns, 'NameExpired')
                .withArgs(name, user1.address, tokenId);

             await expect(sns.ownerOf(tokenId)).to.be.reverted;
        });
    });
  });

  // --- Name Burning (burn) ---
  describe('Name Burning (burn)', function () {
    let sns, registerer, user1, user2, tokenId, otherAccount;

    beforeEach(async function () {
      const fixture = await loadFixture(deploySessionNameServiceFixture);
      sns = fixture.sns;
      registerer = fixture.registerer;
      user1 = fixture.user1;
      user2 = fixture.user2;
      otherAccount = fixture.otherAccount;
      
      await sns.connect(registerer).registerName(user1.address, TEST_NAME_1);
      tokenId = calculateNameHash(TEST_NAME_1);
      
      await sns.connect(user1).setTextRecord(tokenId, SESSION_RECORD_TYPE, "some text");
      expect(await sns.resolve(TEST_NAME_1, SESSION_RECORD_TYPE)).to.equal("some text");
      expect(await sns.totalSupply()).to.equal(1);
    });

    it('Should allow the owner to burn their name NFT', async function () {
      await expect(sns.connect(user1).burn(tokenId))
        .to.emit(sns, 'NameDeleted')
        .withArgs(TEST_NAME_1, user1.address, tokenId)
        .and.to.emit(sns, 'Transfer')
        .withArgs(user1.address, ethers.ZeroAddress, tokenId);

      expect(await sns.totalSupply()).to.equal(0);
      expect(await sns.balanceOf(user1.address)).to.equal(0);
      await expect(sns.ownerOf(tokenId)).to.be.revertedWithCustomError(
          sns,
          'ERC721NonexistentToken'
      );
      
      // After burning, resolve should now revert with NameNotRegistered
      await expect(sns.resolve(TEST_NAME_1, SESSION_RECORD_TYPE))
        .to.be.revertedWithCustomError(sns, 'NameNotRegistered');
      await expect(sns.resolve(TEST_NAME_1, LOKINET_RECORD_TYPE))
        .to.be.revertedWithCustomError(sns, 'NameNotRegistered');
      
      // Just verify that both fields in the TextRecords struct are empty strings
      const textRecords = await sns.tokenIdToTextRecord(tokenId);
      expect(textRecords.sessionName).to.equal("");
      expect(textRecords.lokinetName).to.equal("");
      
      const asset = await sns.namesToAssets(TEST_NAME_1);
      expect(asset.id).to.equal(0);
      const linkedName = await sns.idsToNames(tokenId);
      expect(linkedName).to.equal('');
    });

    it('Should revert if trying to burn a non-existent token', async function () {
        const nonExistentTokenId = calculateNameHash("nonexistent");
        await expect(sns.connect(user1).burn(nonExistentTokenId))
            .to.be.revertedWithCustomError(sns, 'ERC721NonexistentToken')
            .withArgs(nonExistentTokenId);
    });

    it('Should prevent non-owner from burning the token', async function () {
      await expect(sns.connect(otherAccount).burn(tokenId))
        .to.be.revertedWithCustomError(sns, 'ERC721InsufficientApproval')
        .withArgs(otherAccount.address, tokenId);
    });

    it('Should allow re-registration after burning', async function () {
        await sns.connect(user1).burn(tokenId);
        expect(await sns.totalSupply()).to.equal(0);

        const newOwner = user2;
        await expect(sns.connect(registerer).registerName(newOwner.address, TEST_NAME_1))
            .to.emit(sns, 'NameRegistered')
            .withArgs(TEST_NAME_1, newOwner.address, tokenId);

        expect(await sns.ownerOf(tokenId)).to.equal(newOwner.address);
        expect(await sns.totalSupply()).to.equal(1);
    });
  });

  // --- Re-registration after Expiration ---
  describe('Re-registration after Expiration', function () {
     it('Should allow re-registration after expiration', async function () {
        const { sns, owner, registerer, user1, user2, otherAccount } = await loadFixture(deploySessionNameServiceFixture);
        const name = 'expiringname';
        const tokenId = calculateNameHash(name);
        const expirationPeriod = INITIAL_EXPIRATION_DAYS * ONE_DAY;

        await sns.connect(owner).flipRenewals();
        await sns.connect(registerer).registerName(user1.address, name);

        const asset = await sns.namesToAssets(name);
        const expireTime = Number(asset.renewals) + expirationPeriod;
        await time.increaseTo(expireTime + 1);

        await sns.connect(registerer).expireName(name);
        await expect(sns.ownerOf(tokenId)).to.be.revertedWithCustomError(sns, 'ERC721NonexistentToken');
        expect(await sns.totalSupply()).to.equal(0);

        const newOwner = user2;
        await expect(sns.connect(registerer).registerName(newOwner.address, name))
            .to.emit(sns, 'NameRegistered')
            .withArgs(name, newOwner.address, tokenId);

        expect(await sns.ownerOf(tokenId)).to.equal(newOwner.address);
        expect(await sns.totalSupply()).to.equal(1);
        // After re-registration, it should have an empty record again
        expect(await sns.resolve(name, SESSION_RECORD_TYPE)).to.equal("");
    });
  });

  // --- Token URI ---
  describe('Token URI (`tokenURI`)', function () {
     it('Should return the correct token URI for a registered name', async function () {
        const { sns, registerer, user1 } = await loadFixture(deploySessionNameServiceFixture);
        const name = TEST_NAME_1;
        await sns.connect(registerer).registerName(user1.address, name);
        const tokenId = BigInt(calculateNameHash(name));
        const expectedURI = BASE_URI + tokenId.toString();
        expect(await sns.tokenURI(tokenId)).to.equal(expectedURI);
    });

    it('Should return an empty string if baseTokenURI is not set', async function () {
        const { sns, owner, registerer, user1 } = await loadFixture(deploySessionNameServiceFixture);
        await sns.connect(owner).setBaseTokenURI('');
        expect(await sns.baseTokenURI()).to.equal('');

        const name = TEST_NAME_1;
        await sns.connect(registerer).registerName(user1.address, name);
        const tokenId = calculateNameHash(name);
        expect(await sns.tokenURI(tokenId)).to.equal('');
    });

    it('Should revert for a non-existent token', async function () {
       const { sns } = await loadFixture(deploySessionNameServiceFixture);
       const nonExistentTokenId = calculateNameHash('nonexistent');
       await expect(sns.tokenURI(nonExistentTokenId))
           .to.be.revertedWithCustomError(sns, 'ERC721NonexistentToken');
   });
  });

  // --- ERC721 Specifics & Overrides ---
  describe('ERC721 Specifics & Overrides', function () {
    it('Should support required interfaces (ERC721, AccessControl, ISessionNameService)', async function () {
      const { sns } = await loadFixture(deploySessionNameServiceFixture);
      const erc721InterfaceId = '0x80ac58cd';
      const accessControlInterfaceId = '0x7965db0b';

      expect(await sns.supportsInterface(erc721InterfaceId)).to.be.true;
      expect(await sns.supportsInterface(accessControlInterfaceId)).to.be.true;
    });

    it('Should allow minting (from address(0))', async function () {
        const { sns, registerer, user1 } = await loadFixture(deploySessionNameServiceFixture);
        await expect(sns.connect(registerer).registerName(user1.address, TEST_NAME_1)).to.not.be.reverted;
    });

    it('Should allow burning (to address(0))', async function () {
       const { sns, registerer, user1 } = await loadFixture(deploySessionNameServiceFixture);
       await sns.connect(registerer).registerName(user1.address, TEST_NAME_1);
       const tokenId = calculateNameHash(TEST_NAME_1);
       await expect(sns.connect(user1).burn(tokenId)).to.not.be.reverted;
   });
  });

  describe('ERC721 Transfers and Approvals', function () {
      let sns, owner, registerer, user1, user2, otherAccount, tokenId, name;

      beforeEach(async function () {
        const fixture = await loadFixture(deploySessionNameServiceFixture);
        sns = fixture.sns;
        owner = fixture.owner;
        registerer = fixture.registerer;
        user1 = fixture.user1;
        user2 = fixture.user2;
        otherAccount = fixture.otherAccount;
        name = TEST_NAME_1;

        await sns.connect(registerer).registerName(user1.address, name);
        tokenId = calculateNameHash(name);
        await sns.connect(user1).setTextRecord(tokenId, SESSION_RECORD_TYPE, "original text");
        await sns.connect(owner).flipRenewals();
      });

      it('Should allow owner to transfer using transferFrom', async function () {
        await sns.connect(user1).approve(user1.address, tokenId);
        await expect(sns.connect(user1).transferFrom(user1.address, user2.address, tokenId))
            .to.emit(sns, 'Transfer')
            .withArgs(user1.address, user2.address, tokenId);
        expect(await sns.ownerOf(tokenId)).to.equal(user2.address);
        expect(await sns.resolve(name, SESSION_RECORD_TYPE)).to.equal("original text");
        expect(await sns.balanceOf(user1.address)).to.equal(0);
        expect(await sns.balanceOf(user2.address)).to.equal(1);
      });

      it('Should allow owner to transfer using safeTransferFrom', async function () {
        await expect(sns.connect(user1)['safeTransferFrom(address,address,uint256)'](user1.address, user2.address, tokenId))
            .to.emit(sns, 'Transfer')
            .withArgs(user1.address, user2.address, tokenId);
        expect(await sns.ownerOf(tokenId)).to.equal(user2.address);
        expect(await sns.resolve(name, SESSION_RECORD_TYPE)).to.equal("original text");
      });

      it('Should allow approved address to transfer using transferFrom', async function () {
        await sns.connect(user1).approve(user2.address, tokenId);
        expect(await sns.getApproved(tokenId)).to.equal(user2.address);
        await expect(sns.connect(user2).transferFrom(user1.address, otherAccount.address, tokenId))
            .to.emit(sns, 'Transfer')
            .withArgs(user1.address, otherAccount.address, tokenId);
        expect(await sns.ownerOf(tokenId)).to.equal(otherAccount.address);
        expect(await sns.resolve(name, SESSION_RECORD_TYPE)).to.equal("original text");
      });

       it('Should allow approved address to transfer using safeTransferFrom', async function () {
        await sns.connect(user1).approve(user2.address, tokenId);
        await expect(sns.connect(user2)['safeTransferFrom(address,address,uint256)'](user1.address, otherAccount.address, tokenId))
            .to.emit(sns, 'Transfer')
            .withArgs(user1.address, otherAccount.address, tokenId);
        expect(await sns.ownerOf(tokenId)).to.equal(otherAccount.address);
        expect(await sns.resolve(name, SESSION_RECORD_TYPE)).to.equal("original text");
      });

      it('Should allow approved operator (setApprovalForAll) to transfer', async function () {
        await sns.connect(user1).setApprovalForAll(user2.address, true);
        expect(await sns.isApprovedForAll(user1.address, user2.address)).to.be.true;
        await expect(sns.connect(user2).transferFrom(user1.address, otherAccount.address, tokenId))
            .to.emit(sns, 'Transfer')
            .withArgs(user1.address, otherAccount.address, tokenId);
        expect(await sns.ownerOf(tokenId)).to.equal(otherAccount.address);
        expect(await sns.resolve(name, SESSION_RECORD_TYPE)).to.equal("original text");
      });

      it('Should revert transferFrom if caller is not owner or approved', async function () {
        await expect(sns.connect(otherAccount).transferFrom(user1.address, user2.address, tokenId))
            .to.be.revertedWithCustomError(sns, 'ERC721InsufficientApproval')
            .withArgs(otherAccount.address, tokenId);
      });

      it('Should revert transferFrom if from address is not owner', async function () {
         await sns.connect(user1).approve(user2.address, tokenId);
         await expect(sns.connect(user2).transferFrom(otherAccount.address, user2.address, tokenId))
            .to.be.revertedWithCustomError(sns, 'ERC721IncorrectOwner')
            .withArgs(otherAccount.address, tokenId, user1.address);
      });

       it('Should clear approval after transfer', async function () {
        await sns.connect(user1).approve(user2.address, tokenId);
        expect(await sns.getApproved(tokenId)).to.equal(user2.address);
        await sns.connect(user2).transferFrom(user1.address, otherAccount.address, tokenId);
        expect(await sns.getApproved(tokenId)).to.equal(ethers.ZeroAddress);
      });

      it('Should allow the new owner to set text record after transfer', async function () {
        await sns.connect(user1).transferFrom(user1.address, user2.address, tokenId);
        expect(await sns.ownerOf(tokenId)).to.equal(user2.address);

        const newText = "text set by new owner";
        await expect(sns.connect(user2).setTextRecord(tokenId, SESSION_RECORD_TYPE, newText))
            .to.emit(sns, 'TextRecordUpdated')
            .withArgs(tokenId, SESSION_RECORD_TYPE, newText);
        expect(await sns.resolve(name, SESSION_RECORD_TYPE)).to.equal(newText);
        
        // Check the TextRecords fields directly
        const textRecords = await sns.tokenIdToTextRecord(tokenId);
        expect(textRecords.sessionName).to.equal(newText);
        expect(textRecords.lokinetName).to.equal("");
      });

      it('Should allow the new owner to renew after transfer', async function () {
         await sns.connect(user1).transferFrom(user1.address, user2.address, tokenId);
         expect(await sns.ownerOf(tokenId)).to.equal(user2.address);

         await time.increase(ONE_DAY * 10);
         const initialAsset = await sns.namesToAssets(name);
         const testExpirationPeriod = INITIAL_EXPIRATION_DAYS * ONE_DAY;
         const expectedTimestamp = initialAsset.renewals + BigInt(testExpirationPeriod);

         await expect(sns.connect(user2).renewName(name))
           .to.emit(sns, 'NameRenewed')
           .withArgs(name, user2.address, anyValue);

         const renewedAsset = await sns.namesToAssets(name);
         expect(renewedAsset.renewals).to.be.gt(initialAsset.renewals);
         expect(renewedAsset.renewals).to.be.closeTo(expectedTimestamp, 2);
      });

       it('Should revert approve if caller is not owner or approved operator', async function () {
         await expect(sns.connect(otherAccount).approve(user2.address, tokenId))
            .to.be.revertedWithCustomError(sns, 'ERC721InvalidApprover')
            .withArgs(otherAccount.address);
      });

      it('Should allow owner to approve', async function () {
          await expect(sns.connect(user1).approve(user2.address, tokenId)).to.not.be.reverted;
          expect(await sns.getApproved(tokenId)).to.equal(user2.address);
      });

      it('Should allow approved operator to approve on behalf of owner', async function () {
          await sns.connect(user1).setApprovalForAll(otherAccount.address, true);
          await expect(sns.connect(otherAccount).approve(user2.address, tokenId)).to.not.be.reverted;
          expect(await sns.getApproved(tokenId)).to.equal(user2.address);
      });

      it('Should allow owner to setApprovalForAll', async function () {
          await expect(sns.connect(user1).setApprovalForAll(user2.address, true)).to.not.be.reverted;
          expect(await sns.isApprovedForAll(user1.address, user2.address)).to.be.true;
          await expect(sns.connect(user1).setApprovalForAll(user2.address, false)).to.not.be.reverted;
          expect(await sns.isApprovedForAll(user1.address, user2.address)).to.be.false;
      });
   });

   // --- Internal Helper Functions (Tested via public functions) ---
   describe('Internal Helper Functions (isValidBase64)', function() {
       it('isValidBase64 works as expected (tested via registration)', async function() {
            const { sns, registerer, user1 } = await loadFixture(deploySessionNameServiceFixture);
            // Valid chars (A-Z, a-z, 0-9, +, /, =)
            await expect(sns.connect(registerer).registerName(user1.address, TEST_NAME_1)).to.not.be.reverted; // alice
            await sns.connect(user1).burn(calculateNameHash(TEST_NAME_1));
            await expect(sns.connect(registerer).registerName(user1.address, TEST_NAME_UPPER)).to.not.be.reverted; // ALICE
            await sns.connect(user1).burn(calculateNameHash(TEST_NAME_UPPER));
            await expect(sns.connect(registerer).registerName(user1.address, TEST_NAME_WITH_NUMBERS)).to.not.be.reverted; // name123
            await sns.connect(user1).burn(calculateNameHash(TEST_NAME_WITH_NUMBERS));
            await expect(sns.connect(registerer).registerName(user1.address, TEST_NAME_WITH_PLUS)).to.not.be.reverted; // name+plus
            await sns.connect(user1).burn(calculateNameHash(TEST_NAME_WITH_PLUS));
            await expect(sns.connect(registerer).registerName(user1.address, TEST_NAME_WITH_SLASH)).to.not.be.reverted; // name/slash
            await sns.connect(user1).burn(calculateNameHash(TEST_NAME_WITH_SLASH));
            await expect(sns.connect(registerer).registerName(user1.address, TEST_NAME_WITH_EQUALS)).to.not.be.reverted; // name==
            await sns.connect(user1).burn(calculateNameHash(TEST_NAME_WITH_EQUALS));
            await expect(sns.connect(registerer).registerName(user1.address, TEST_NAME_MIXED)).to.not.be.reverted; // Alice
            // Don't burn the last one

            // Invalid chars
            await expect(sns.connect(registerer).registerName(user1.address, TEST_NAME_INVALID_CHARS)) // invalid!
                .to.be.revertedWithCustomError(sns, 'UnsupportedCharacters');
            await expect(sns.connect(registerer).registerName(user1.address, TEST_NAME_INVALID_SPACE)) // invalid space
                .to.be.revertedWithCustomError(sns, 'UnsupportedCharacters');
            await expect(sns.connect(registerer).registerName(user1.address, TEST_NAME_INVALID_DASH)) // invalid-dash
                .to.be.revertedWithCustomError(sns, 'UnsupportedCharacters');
            await expect(sns.connect(registerer).registerName(user1.address, TEST_NAME_INVALID_UNICODE)) // 你好
                .to.be.revertedWithCustomError(sns, 'UnsupportedCharacters');
       });
   });

  // --- Text Record Management ---
  describe('Text Record Management (setTextRecord)', function () {
    let sns, owner, registerer, user1, user2, tokenId, otherAccount;
    const testText = "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef"; // Example 64 char hex

    beforeEach(async function () {
      const fixture = await loadFixture(deploySessionNameServiceFixture);
      sns = fixture.sns;
      owner = fixture.owner;
      registerer = fixture.registerer;
      user1 = fixture.user1;
      user2 = fixture.user2;
      otherAccount = fixture.otherAccount;
      // Register a name for user1
      await sns.connect(registerer).registerName(user1.address, TEST_NAME_1);
      tokenId = calculateNameHash(TEST_NAME_1);
      // Initial check: resolve returns empty string
      expect(await sns.resolve(TEST_NAME_1, SESSION_RECORD_TYPE)).to.equal("");
      expect(await sns.resolve(TEST_NAME_1, LOKINET_RECORD_TYPE)).to.equal("");
    });

    it('Should allow the owner to set the session text record', async function () {
      await expect(sns.connect(user1).setTextRecord(tokenId, SESSION_RECORD_TYPE, testText))
        .to.emit(sns, 'TextRecordUpdated')
        .withArgs(tokenId, SESSION_RECORD_TYPE, testText);
      
      // Check that the session record was set but lokinet is still empty
      expect(await sns.resolve(TEST_NAME_1, SESSION_RECORD_TYPE)).to.equal(testText);
      expect(await sns.resolve(TEST_NAME_1, LOKINET_RECORD_TYPE)).to.equal("");
    });

    it('Should allow the owner to set the lokinet text record', async function () {
      await expect(sns.connect(user1).setTextRecord(tokenId, LOKINET_RECORD_TYPE, testText))
        .to.emit(sns, 'TextRecordUpdated')
        .withArgs(tokenId, LOKINET_RECORD_TYPE, testText);
      
      // Check that the lokinet record was set but session is still empty
      expect(await sns.resolve(TEST_NAME_1, SESSION_RECORD_TYPE)).to.equal("");
      expect(await sns.resolve(TEST_NAME_1, LOKINET_RECORD_TYPE)).to.equal(testText);
    });

    it('Should allow an approved address to set text records of different types', async function () {
      const sessionText = "approved session text";
      const lokinetText = "approved lokinet text";
      
      await sns.connect(user1).approve(user2.address, tokenId);
      
      await expect(sns.connect(user2).setTextRecord(tokenId, SESSION_RECORD_TYPE, sessionText))
        .to.emit(sns, 'TextRecordUpdated')
        .withArgs(tokenId, SESSION_RECORD_TYPE, sessionText);
      
      await expect(sns.connect(user2).setTextRecord(tokenId, LOKINET_RECORD_TYPE, lokinetText))
        .to.emit(sns, 'TextRecordUpdated')
        .withArgs(tokenId, LOKINET_RECORD_TYPE, lokinetText);
      
      // Verify both record types are set correctly
      expect(await sns.resolve(TEST_NAME_1, SESSION_RECORD_TYPE)).to.equal(sessionText);
      expect(await sns.resolve(TEST_NAME_1, LOKINET_RECORD_TYPE)).to.equal(lokinetText);
    });

    it('Should allow an approved operator (setApprovalForAll) to set text records', async function () {
      const sessionText = "operator session text";
      const lokinetText = "operator lokinet text";
      
      await sns.connect(user1).setApprovalForAll(user2.address, true);
      
      await expect(sns.connect(user2).setTextRecord(tokenId, SESSION_RECORD_TYPE, sessionText))
        .to.emit(sns, 'TextRecordUpdated')
        .withArgs(tokenId, SESSION_RECORD_TYPE, sessionText);
      
      await expect(sns.connect(user2).setTextRecord(tokenId, LOKINET_RECORD_TYPE, lokinetText))
        .to.emit(sns, 'TextRecordUpdated')
        .withArgs(tokenId, LOKINET_RECORD_TYPE, lokinetText);
      
      // Verify both record types are set correctly
      expect(await sns.resolve(TEST_NAME_1, SESSION_RECORD_TYPE)).to.equal(sessionText);
      expect(await sns.resolve(TEST_NAME_1, LOKINET_RECORD_TYPE)).to.equal(lokinetText);
      
      // Set back to empty for both types
      await expect(sns.connect(user1).setTextRecord(tokenId, SESSION_RECORD_TYPE, ""))
        .to.emit(sns, 'TextRecordUpdated')
        .withArgs(tokenId, SESSION_RECORD_TYPE, "");
      
      await expect(sns.connect(user1).setTextRecord(tokenId, LOKINET_RECORD_TYPE, ""))
        .to.emit(sns, 'TextRecordUpdated')
        .withArgs(tokenId, LOKINET_RECORD_TYPE, "");
      
      // Verify both are empty again
      expect(await sns.resolve(TEST_NAME_1, SESSION_RECORD_TYPE)).to.equal("");
      expect(await sns.resolve(TEST_NAME_1, LOKINET_RECORD_TYPE)).to.equal("");
    });

    it('Should prevent non-owner/non-approved from setting the text record', async function () {
      // Using registerer account (not owner or approved)
      await expect(sns.connect(registerer).setTextRecord(tokenId, SESSION_RECORD_TYPE, testText))
        .to.be.revertedWithCustomError(sns, 'NotAuthorized');
      
      await expect(sns.connect(registerer).setTextRecord(tokenId, LOKINET_RECORD_TYPE, testText))
        .to.be.revertedWithCustomError(sns, 'NotAuthorized');
      
      // Using other account (not owner or approved)
      await expect(sns.connect(otherAccount).setTextRecord(tokenId, SESSION_RECORD_TYPE, testText))
        .to.be.revertedWithCustomError(sns, 'NotAuthorized');
      
      await expect(sns.connect(otherAccount).setTextRecord(tokenId, LOKINET_RECORD_TYPE, testText))
        .to.be.revertedWithCustomError(sns, 'NotAuthorized');
    });

    it('Should prevent setting the text record for a non-existent token', async function () {
      const nonExistentTokenId = calculateNameHash("nonexistent");
      await expect(sns.connect(user1).setTextRecord(nonExistentTokenId, SESSION_RECORD_TYPE, testText))
            .to.be.revertedWithCustomError(sns, 'ERC721NonexistentToken')
            .withArgs(nonExistentTokenId);
      
      await expect(sns.connect(user1).setTextRecord(nonExistentTokenId, LOKINET_RECORD_TYPE, testText))
            .to.be.revertedWithCustomError(sns, 'ERC721NonexistentToken')
            .withArgs(nonExistentTokenId);
    });

    it('Should revert with InvalidRecordType for unsupported record types', async function () {
      // Using record type 2 which is unused/invalid
      await expect(sns.connect(user1).setTextRecord(tokenId, 2, testText))
        .to.be.revertedWithCustomError(sns, 'InvalidRecordType');
      
      // Using record type 4 which is also invalid
      await expect(sns.connect(user1).setTextRecord(tokenId, 4, testText))
        .to.be.revertedWithCustomError(sns, 'InvalidRecordType');
    });

    it('Should allow setting empty text records for both types', async function () {
      // Set session record
      await sns.connect(user1).setTextRecord(tokenId, SESSION_RECORD_TYPE, testText);
      expect(await sns.resolve(TEST_NAME_1, SESSION_RECORD_TYPE)).to.equal(testText);
      
      // Set lokinet record
      const lokinetText = "lokinet test text";
      await sns.connect(user1).setTextRecord(tokenId, LOKINET_RECORD_TYPE, lokinetText);
      expect(await sns.resolve(TEST_NAME_1, LOKINET_RECORD_TYPE)).to.equal(lokinetText);
      
      // Set both back to empty
      await expect(sns.connect(user1).setTextRecord(tokenId, SESSION_RECORD_TYPE, ""))
        .to.emit(sns, 'TextRecordUpdated')
        .withArgs(tokenId, SESSION_RECORD_TYPE, "");
      
      await expect(sns.connect(user1).setTextRecord(tokenId, LOKINET_RECORD_TYPE, ""))
        .to.emit(sns, 'TextRecordUpdated')
        .withArgs(tokenId, LOKINET_RECORD_TYPE, "");
      
      // Verify both are empty
      expect(await sns.resolve(TEST_NAME_1, SESSION_RECORD_TYPE)).to.equal("");
      expect(await sns.resolve(TEST_NAME_1, LOKINET_RECORD_TYPE)).to.equal("");
    });

    it('Should allow the owner to set a text record before renewal', async function () {
        const originalText = "original text";
        await sns.connect(user1).setTextRecord(tokenId, SESSION_RECORD_TYPE, originalText);

        // Check text record is set
        expect(await sns.resolve(TEST_NAME_1, SESSION_RECORD_TYPE)).to.equal(originalText);

        // Enable renewals
        await sns.connect(owner).flipRenewals();
        expect(await sns.allowRenewals()).to.be.true;

        // Verify renewal keeps the text record
        await time.increase(ONE_DAY * 10);
        await sns.connect(user1).renewName(TEST_NAME_1);

        // Text record should still be available
        expect(await sns.resolve(TEST_NAME_1, SESSION_RECORD_TYPE)).to.equal(originalText);
     });

     it('Should preserve the text record after renewal', async function () {
       const originalText = "original text";
       // Set text record
       await sns.connect(user1).setTextRecord(tokenId, SESSION_RECORD_TYPE, originalText);

       // Advance time
       await time.increase(ONE_DAY * 20);

       // Enable renewals
       await sns.connect(owner).flipRenewals();
       expect(await sns.allowRenewals()).to.be.true;

       // Renew
       await sns.connect(user1).renewName(TEST_NAME_1);

       // Text record should be preserved
       expect(await sns.resolve(TEST_NAME_1, SESSION_RECORD_TYPE)).to.equal(originalText);
     });

     it('Should allow updating text record after renewal', async function () {
       const originalText = "original text";
       const updatedText = "updated after renewal";

       // Set text record
       await sns.connect(user1).setTextRecord(tokenId, SESSION_RECORD_TYPE, originalText);
       expect(await sns.resolve(TEST_NAME_1, SESSION_RECORD_TYPE)).to.equal(originalText);

       // Advance time
       await time.increase(ONE_DAY * 20);

       // Enable renewals
       await sns.connect(owner).flipRenewals();
       expect(await sns.allowRenewals()).to.be.true;

       // Renew
       await sns.connect(user1).renewName(TEST_NAME_1);

       // Update text record
       await sns.connect(user1).setTextRecord(tokenId, SESSION_RECORD_TYPE, updatedText);

       // Text record should be updated
       expect(await sns.resolve(TEST_NAME_1, SESSION_RECORD_TYPE)).to.equal(updatedText);
     });

     it('Should transfer name with text record intact', async function () {
       const originalText = "original text";

       // Set text record
       await sns.connect(user1).setTextRecord(tokenId, SESSION_RECORD_TYPE, originalText);
       expect(await sns.resolve(TEST_NAME_1, SESSION_RECORD_TYPE)).to.equal(originalText);

       // Transfer to user2
       await sns.connect(user1).transferFrom(user1.address, user2.address, tokenId);

       // Text record should be preserved after transfer
       expect(await sns.resolve(TEST_NAME_1, SESSION_RECORD_TYPE)).to.equal(originalText);

       // New owner can update the text record
       const newText = "updated by new owner";
       await sns.connect(user2).setTextRecord(tokenId, SESSION_RECORD_TYPE, newText);
       expect(await sns.resolve(TEST_NAME_1, SESSION_RECORD_TYPE)).to.equal(newText);
     });
  });

  // --- Total Supply Management ---
  describe('Total Supply Management', function () {
    it('Should increment totalSupply on registration', async function () {
        const { sns, registerer, user1, user2 } = await loadFixture(deploySessionNameServiceFixture);
        expect(await sns.totalSupply()).to.equal(0);

        await sns.connect(registerer).registerName(user1.address, 'supplytest1');
        expect(await sns.totalSupply()).to.equal(1);

        await sns.connect(registerer).registerName(user2.address, 'supplytest2');
        expect(await sns.totalSupply()).to.equal(2);
    });

    it('Should decrement totalSupply on burn', async function () {
        const { sns, registerer, user1, user2 } = await loadFixture(deploySessionNameServiceFixture);
        const name1 = 'burnsupply1';
        const name2 = 'burnsupply2';
        const tokenId1 = calculateNameHash(name1);
        const tokenId2 = calculateNameHash(name2);

        await sns.connect(registerer).registerName(user1.address, name1);
        await sns.connect(registerer).registerName(user2.address, name2);
        expect(await sns.totalSupply()).to.equal(2);

        await sns.connect(user1).burn(tokenId1);
        expect(await sns.totalSupply()).to.equal(1);

        await sns.connect(user2).burn(tokenId2);
        expect(await sns.totalSupply()).to.equal(0);
    });

    it('Should decrement totalSupply on expiration', async function () {
        const { sns, owner, registerer, user1, user2 } = await loadFixture(deploySessionNameServiceFixture);
        const name1 = 'expiresupply1';
        const name2 = 'expiresupply2';
        const expirationPeriod = INITIAL_EXPIRATION_DAYS * ONE_DAY;

        // Enable renewals and register names
        await sns.connect(owner).flipRenewals();
        await sns.connect(registerer).registerName(user1.address, name1);
        await sns.connect(registerer).registerName(user2.address, name2);
        expect(await sns.totalSupply()).to.equal(2);

        // Expire first name
        const asset1 = await sns.namesToAssets(name1);
        const expireTime1 = Number(asset1.renewals) + expirationPeriod;
        await time.setNextBlockTimestamp(expireTime1 + 1);
        await ethers.provider.send('evm_mine', []);
        await sns.connect(registerer).expireName(name1);
        expect(await sns.totalSupply()).to.equal(1, "Total supply did not decrease after first expiration");

        // Expire second name
        const asset2 = await sns.namesToAssets(name2);
        const expireTime2 = Number(asset2.renewals) + expirationPeriod;
        await time.setNextBlockTimestamp(expireTime2 + 10);
        await ethers.provider.send('evm_mine', []);
        await sns.connect(registerer).expireName(name2);
        expect(await sns.totalSupply()).to.equal(0, "Total supply did not decrease after second expiration");
    });
  });

  // --- Fee Management ---
  describe('Fee Management', function () {
    it('Only ADMIN_ROLE can set payment token', async function () {
      const { sns, owner, otherAccount, mockToken } = await loadFixture(deploySessionNameServiceFixture);
      
      await expect(sns.connect(owner).setPaymentToken(await mockToken.getAddress()))
        .to.emit(sns, 'PaymentTokenSet')
        .withArgs(await mockToken.getAddress());

      await expect(
        sns.connect(otherAccount).setPaymentToken(await mockToken.getAddress())
      ).to.be.revertedWithCustomError(sns, 'AccessControlUnauthorizedAccount');
    });

    it('Only ADMIN_ROLE can set fees', async function () {
      const { sns, owner, otherAccount } = await loadFixture(deploySessionNameServiceFixture);
      
      await expect(sns.connect(owner).setFees(REGISTRATION_FEE, TRANSFER_FEE))
        .to.emit(sns, 'FeesSet')
        .withArgs(REGISTRATION_FEE, TRANSFER_FEE);

      await expect(
        sns.connect(otherAccount).setFees(REGISTRATION_FEE, TRANSFER_FEE)
      ).to.be.revertedWithCustomError(sns, 'AccessControlUnauthorizedAccount');
    });

    it('Only ADMIN_ROLE can withdraw fees', async function () {
      const { sns, owner, otherAccount, user1, mockToken } = await loadFixture(deploySessionNameServiceFixture);
      
      // Register a name to generate some fees
      await sns.connect(owner).registerName(user1.address, TEST_NAME_1);
      
      const initialBalance = await mockToken.balanceOf(owner.address);
      
      await expect(sns.connect(owner).withdrawFees(owner.address))
        .to.emit(sns, 'FeesWithdrawn')
        .withArgs(owner.address, REGISTRATION_FEE);

      const finalBalance = await mockToken.balanceOf(owner.address);
      expect(finalBalance - initialBalance).to.equal(REGISTRATION_FEE);

      await expect(
        sns.connect(otherAccount).withdrawFees(otherAccount.address)
      ).to.be.revertedWithCustomError(sns, 'AccessControlUnauthorizedAccount');
    });

    it('Registration requires payment of fee', async function () {
      const { sns, registerer, user1, mockToken } = await loadFixture(deploySessionNameServiceFixture);
      
      const initialBalance = await mockToken.balanceOf(user1.address);
      
      await expect(sns.connect(registerer).registerName(user1.address, TEST_NAME_1))
        .to.emit(sns, 'NameRegistered')
        .withArgs(TEST_NAME_1, user1.address, calculateNameHash(TEST_NAME_1));

      const finalBalance = await mockToken.balanceOf(user1.address);
      expect(initialBalance - finalBalance).to.equal(REGISTRATION_FEE);
    });

    it('Transfer requires payment of fee', async function () {
      const { sns, registerer, user1, user2, mockToken } = await loadFixture(deploySessionNameServiceFixture);
      
      // Register a name first
      await sns.connect(registerer).registerName(user1.address, TEST_NAME_1);
      
      const initialBalance = await mockToken.balanceOf(user1.address);
      
      // Transfer the name
      await expect(sns.connect(user1).transferFrom(user1.address, user2.address, calculateNameHash(TEST_NAME_1)))
        .to.emit(sns, 'Transfer')
        .withArgs(user1.address, user2.address, calculateNameHash(TEST_NAME_1));

      const finalBalance = await mockToken.balanceOf(user1.address);
      expect(initialBalance - finalBalance).to.equal(TRANSFER_FEE);
    });

    it('Renewal requires payment of fee', async function () {
      const { sns, owner, registerer, user1, mockToken } = await loadFixture(deploySessionNameServiceFixture);
      
      // Enable renewals
      await sns.connect(owner).flipRenewals();
      
      // Register a name first
      await sns.connect(registerer).registerName(user1.address, TEST_NAME_1);
      
      const initialBalance = await mockToken.balanceOf(user1.address);
      
      // Renew the name
      await expect(sns.connect(user1).renewName(TEST_NAME_1))
        .to.emit(sns, 'NameRenewed')
        .withArgs(TEST_NAME_1, user1.address, anyValue);

      const finalBalance = await mockToken.balanceOf(user1.address);
      expect(initialBalance - finalBalance).to.equal(REGISTRATION_FEE);
    });

    it('Cannot register without sufficient token balance', async function () {
      const { sns, registerer, user1, mockToken } = await loadFixture(deploySessionNameServiceFixture);
      
      // Set allowance to 0 to simulate insufficient balance
      await mockToken.connect(user1).approve(await sns.getAddress(), 0);
      
      await expect(
        sns.connect(registerer).registerName(user1.address, TEST_NAME_1)
      ).to.be.revertedWithCustomError(mockToken, 'ERC20InsufficientAllowance')
      .withArgs(await sns.getAddress(), 0, REGISTRATION_FEE);
    });

    it('Cannot transfer without sufficient token balance', async function () {
      const { sns, registerer, user1, user2, mockToken } = await loadFixture(deploySessionNameServiceFixture);
      
      // Register a name first
      await sns.connect(registerer).registerName(user1.address, TEST_NAME_1);
      
      // Set allowance to 0 to simulate insufficient balance
      await mockToken.connect(user1).approve(await sns.getAddress(), 0);
      
      await expect(
        sns.connect(user1).transferFrom(user1.address, user2.address, calculateNameHash(TEST_NAME_1))
      ).to.be.revertedWithCustomError(mockToken, 'ERC20InsufficientAllowance')
      .withArgs(await sns.getAddress(), 0, TRANSFER_FEE);
    });
  });
});
