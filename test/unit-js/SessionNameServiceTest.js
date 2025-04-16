const {
  loadFixture,
  time,
} = require('@nomicfoundation/hardhat-toolbox/network-helpers');
const { expect } = require('chai');
const { ethers } = require('hardhat');
const { anyValue } = require("@nomicfoundation/hardhat-chai-matchers/withArgs");

// Helper function to calculate name hash (token ID)
function calculateNameHash(name) {
  const lowerCaseName = name.toLowerCase();
  return ethers.keccak256(ethers.toUtf8Bytes(lowerCaseName));
}

describe('SessionNameService', function () {
  const BASE_URI = 'https://api.example.com/sns/';
  const TEST_NAME_1 = 'alice';
  const TEST_NAME_2 = 'bob';
  const TEST_NAME_INVALID_CHARS = 'charlie!';
  const TEST_NAME_UPPER = 'ALICE'; // For case-insensitivity check
  const INITIAL_EXPIRATION_DAYS = 365;
  const ONE_DAY = 24 * 60 * 60;
  const THIRTY_DAYS = 30 * ONE_DAY;
  const YEAR_PLUS_ONE_DAY = (INITIAL_EXPIRATION_DAYS + 1) * ONE_DAY;

  async function deploySessionNameServiceFixture() {
    const [owner, registerer, user1, user2, otherAccount] =
      await ethers.getSigners();

    const SessionNameServiceFactory = await ethers.getContractFactory(
      'SessionNameService'
    );
    const sns = await SessionNameServiceFactory.deploy(BASE_URI);
    await sns.waitForDeployment();

    // Grant REGISTERER_ROLE to the 'registerer' account
    const REGISTERER_ROLE = await sns.REGISTERER_ROLE();
    await sns.connect(owner).grantRole(REGISTERER_ROLE, registerer.address);

    return {
      sns,
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

     it('Only REGISTERER_ROLE or ADMIN_ROLE can call registerNameMultiple', async function () {
      const { sns, registerer, owner, user1, user2, otherAccount } = await loadFixture(
        deploySessionNameServiceFixture
      );
      const names = ['multi1', 'multi2'];
      const addresses = [user1.address, user2.address];

      const tx = sns.connect(registerer).registerNameMultiple(addresses, names);

      for (let i = 0; i < names.length; i++) {
          const name = names[i];
          const addr = addresses[i];
          const tokenId = calculateNameHash(name);
          await expect(tx)
              .to.emit(sns, 'NameRegistered')
              .withArgs(name, addr, tokenId);
      }

      expect(await sns.ownerOf(calculateNameHash(names[0]))).to.equal(addresses[0]);
      expect(await sns.ownerOf(calculateNameHash(names[1]))).to.equal(addresses[1]);
      expect(await sns.resolve(names[0])).to.equal("");
      expect(await sns.resolve(names[1])).to.equal("");
      expect(await sns.balanceOf(user1.address)).to.equal(1);
      expect(await sns.balanceOf(user2.address)).to.equal(1);
      expect(await sns.totalSupply()).to.equal(2);

      // Burn first to avoid "already have name" error for owner
      const hashMulti1 = calculateNameHash('multi1');
      const hashMulti2 = calculateNameHash('multi2');
      await sns.connect(user1).burn(hashMulti1);
      await sns.connect(user2).burn(hashMulti2);

      const namesAdmin = ['adminmulti1', 'adminmulti2'];
      const addressesAdmin = [otherAccount.address, owner.address];
      await expect(sns.connect(owner).registerNameMultiple(addressesAdmin, namesAdmin))
        .to.not.be.reverted;

      const namesFail = ['failmulti1'];
      const addressesFail = [otherAccount.address];
      // Need to burn adminmulti1 first
      const hashAdminMulti1 = calculateNameHash('adminmulti1');
      await sns.connect(otherAccount).burn(hashAdminMulti1);

      await expect(
        sns.connect(otherAccount).registerNameMultiple(addressesFail, namesFail)
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
      expect(await sns.resolve(TEST_NAME_1)).to.equal("");
      expect(await sns.balanceOf(user1.address)).to.equal(1);
      expect(await sns.totalSupply()).to.equal(1);
      
      const asset = await sns.namesToAssets(TEST_NAME_1);
      expect(asset.id).to.equal(tokenId);
      expect(asset.renewals).to.be.gt(0);
      const linkedName = await sns.idsToNames(tokenId);
      expect(linkedName).to.equal(TEST_NAME_1);
    });

    it('Should handle case-insensitivity on registration and store lowercase', async function () {
      const { sns, registerer, user1 } = await loadFixture(
        deploySessionNameServiceFixture
      );
      const nameUpper = TEST_NAME_UPPER; // "ALICE"
      const nameLower = TEST_NAME_1;   // "alice"
      const tokenId = calculateNameHash(nameLower); // Hash is based on lowercase

      await expect(sns.connect(registerer).registerName(user1.address, nameUpper))
        .to.emit(sns, 'NameRegistered')
        .withArgs(nameLower, user1.address, tokenId);

      expect(await sns.ownerOf(tokenId)).to.equal(user1.address);
      expect(await sns.resolve(nameUpper)).to.equal("");
      expect(await sns.resolve(nameLower)).to.equal("");

      const nameAsset = await sns.namesToAssets(nameLower);
      expect(nameAsset.id).to.equal(tokenId);
      const nameAssetUpper = await sns.namesToAssets(nameUpper);
      expect(nameAssetUpper.id).to.equal(0);

      const linkedName = await sns.idsToNames(tokenId);
      expect(linkedName).to.equal(nameLower);
    });

    it('Should revert if registering an empty name', async function () {
      const { sns, registerer, user1 } = await loadFixture(
        deploySessionNameServiceFixture
      );
      await expect(
        sns.connect(registerer).registerName(user1.address, '')
      ).to.be.revertedWithCustomError(sns, 'NullName');
    });

    it('Should revert if registering a name with invalid characters', async function () {
      const { sns, registerer, user1 } = await loadFixture(
        deploySessionNameServiceFixture
      );
      await expect(
        sns.connect(registerer).registerName(user1.address, TEST_NAME_INVALID_CHARS)
      ).to.be.revertedWithCustomError(sns, 'UnsupportedCharacters');
       await expect(
        sns.connect(registerer).registerName(user1.address, "with space")
      ).to.be.revertedWithCustomError(sns, 'UnsupportedCharacters');
    });

    it('Should revert if registering a name that is already registered', async function () {
      const { sns, registerer, user1, user2 } = await loadFixture(
        deploySessionNameServiceFixture
      );
      await sns.connect(registerer).registerName(user1.address, TEST_NAME_1);
      await expect(
        sns.connect(registerer).registerName(user2.address, TEST_NAME_1)
      ).to.be.revertedWithCustomError(sns, 'NameAlreadyRegistered');
      
      await expect(
        sns.connect(registerer).registerName(user2.address, TEST_NAME_UPPER)
      ).to.be.revertedWithCustomError(sns, 'NameAlreadyRegistered');
    });

    it('Should return the correct token ID on successful registration', async function () {
        const { sns, registerer, user1 } = await loadFixture(deploySessionNameServiceFixture);
        const name = TEST_NAME_1;
        const expectedTokenId = calculateNameHash(name);
        const returnedTokenId = await sns.connect(registerer).registerName.staticCall(user1.address, name);
        expect(returnedTokenId).to.equal(expectedTokenId);
    });
  });

   // --- Multiple Name Registration ---
  describe('Multiple Name Registration (`registerNameMultiple`)', function () {
        it('Should allow REGISTERER to register multiple valid names', async function () {
            const { sns, registerer, user1, user2 } = await loadFixture(deploySessionNameServiceFixture);
            const names = ['nameone', 'nametwo'];
            const addresses = [user1.address, user2.address];
            const tokenId1 = calculateNameHash(names[0]);
            const tokenId2 = calculateNameHash(names[1]);

            const tx = sns.connect(registerer).registerNameMultiple(addresses, names);

            for (let i = 0; i < names.length; i++) {
                const name = names[i];
                const owner = addresses[i];
                const tokenId = calculateNameHash(name);
                await expect(tx)
                    .to.emit(sns, 'NameRegistered')
                    .withArgs(name, owner, tokenId);
            }

            expect(await sns.ownerOf(tokenId1)).to.equal(addresses[0]);
            expect(await sns.ownerOf(tokenId2)).to.equal(addresses[1]);
            expect(await sns.resolve(names[0])).to.equal("");
            expect(await sns.resolve(names[1])).to.equal("");
            expect(await sns.balanceOf(user1.address)).to.equal(1);
            expect(await sns.balanceOf(user2.address)).to.equal(1);
            expect(await sns.totalSupply()).to.equal(2);
        });

        it('Should revert if input array lengths mismatch', async function () {
            const { sns, registerer, user1 } = await loadFixture(deploySessionNameServiceFixture);
            const names = ['nameone'];
            const addresses = [user1.address, user1.address]; // Length mismatch

            await expect(
                sns.connect(registerer).registerNameMultiple(addresses, names)
            ).to.be.revertedWithCustomError(sns, 'InvalidInputLengths');
        });

        it('Should revert entire batch if one registration fails (e.g., duplicate name)', async function () {
            const { sns, owner, registerer, user1, user2, otherAccount } = await loadFixture(deploySessionNameServiceFixture);
            await sns.connect(registerer).registerName(user1.address, 'existing');

            const names = ['newname', 'existing', 'anothernew']; // Contains duplicate
            const addresses = [user2.address, otherAccount.address, owner.address];

            await expect(
                sns.connect(registerer).registerNameMultiple(addresses, names)
            ).to.be.revertedWithCustomError(sns, 'NameAlreadyRegistered');

            expect(sns.resolve('newname')).to.be.revertedWithCustomError(sns, 'ERC721NonexistentToken');
            expect(sns.resolve('anothernew')).to.be.revertedWithCustomError(sns, 'ERC721NonexistentToken');
            expect(await sns.balanceOf(user2.address)).to.equal(0);
            expect(await sns.balanceOf(otherAccount.address)).to.equal(0);
            expect(await sns.totalSupply()).to.equal(1);
        });

    });

  // --- Name Resolution ---
  describe('Name Resolution (`resolve`)', function () {
    it('Should resolve a registered name to its owner', async function () {
      const { sns, registerer, user1 } = await loadFixture(
        deploySessionNameServiceFixture
      );
      await sns.connect(registerer).registerName(user1.address, TEST_NAME_1);
      expect(await sns.resolve(TEST_NAME_1)).to.equal("");
    });

    it('Should resolve a registered name case-insensitively', async function () {
      const { sns, registerer, user1 } = await loadFixture(
        deploySessionNameServiceFixture
      );
      await sns.connect(registerer).registerName(user1.address, TEST_NAME_1);
      expect(await sns.resolve(TEST_NAME_UPPER)).to.equal("");
    });

    it('Should return address(0) for an unregistered name', async function () {
      const { sns } = await loadFixture(deploySessionNameServiceFixture);
      await expect(sns.resolve('nonexistent')).to.be.revertedWithCustomError(sns, 'NameNotRegistered');
    });

     it('Should return address(0) after a name is burned', async function () {
      const { sns, registerer, user1 } = await loadFixture(deploySessionNameServiceFixture);
      const name = TEST_NAME_1;
      await sns.connect(registerer).registerName(user1.address, name);
      const tokenId = calculateNameHash(name);
      expect(await sns.resolve(name)).to.equal("");

      await sns.connect(user1).burn(tokenId);

      await expect(sns.resolve(name)).to.be.revertedWithCustomError(sns, 'NameNotRegistered');
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
        const expectedTimestamp = BigInt(await time.latest()) + 1n;

        await expect(sns.connect(user1).renewName(name))
          .to.emit(sns, 'NameRenewed')
          .withArgs(name, user1.address, anyValue);

        const renewedAsset = await sns.namesToAssets(name);
        expect(renewedAsset.renewals).to.be.gt(initialTimestamp);
        expect(renewedAsset.renewals).to.be.closeTo(expectedTimestamp, 2);
      });

      it('Should revert if called by someone other than the owner', async function () {
        await expect(sns.connect(otherAccount).renewName(name))
          .to.be.revertedWithCustomError(sns, 'ERC721IncorrectOwner');
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

      it('Should handle case-insensitivity for renewal', async function () {
          const initialAsset = await sns.namesToAssets(name);
          const initialTimestamp = initialAsset.renewals;

          await time.increase(ONE_DAY * 5);
          const expectedTimestamp = BigInt(await time.latest()) + 1n;

          await expect(sns.connect(user1).renewName(TEST_NAME_UPPER))
              .to.emit(sns, 'NameRenewed')
              .withArgs(name, user1.address, anyValue);

          const renewedAsset = await sns.namesToAssets(name);
          expect(renewedAsset.renewals).to.be.gt(initialTimestamp);
          expect(renewedAsset.renewals).to.be.closeTo(expectedTimestamp, 2);
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

         it('Should handle case-insensitivity for expiration', async function () {
            const initialAsset = await sns.namesToAssets(name);
            const renewalTimestamp = initialAsset.renewals;
            const expireTime = Number(renewalTimestamp) + expirationPeriod;

            await time.increaseTo(expireTime + 1);

            await expect(sns.connect(registerer).expireName(TEST_NAME_UPPER))
                .to.emit(sns, 'NameExpired')
                .withArgs(name, user1.address, tokenId);

            await expect(sns.ownerOf(tokenId)).to.be.reverted;
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
      
      await sns.connect(user1).setTextRecord(tokenId, "some text");
      expect(await sns.resolve(TEST_NAME_1)).to.equal("some text");
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
      
      await expect(sns.resolve(TEST_NAME_1)).to.be.revertedWithCustomError(
        sns,
        'NameNotRegistered'
      );
      
      expect(await sns.tokenIdToTextRecord(tokenId)).to.equal("");
      
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
        expect(await sns.resolve(name)).to.equal("");
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
        await sns.connect(user1).setTextRecord(tokenId, "original text");
        await sns.connect(owner).flipRenewals();
      });

      it('Should allow owner to transfer using transferFrom', async function () {
        await sns.connect(user1).approve(user1.address, tokenId);
        await expect(sns.connect(user1).transferFrom(user1.address, user2.address, tokenId))
            .to.emit(sns, 'Transfer')
            .withArgs(user1.address, user2.address, tokenId);
        expect(await sns.ownerOf(tokenId)).to.equal(user2.address);
        expect(await sns.resolve(name)).to.equal("original text");
        expect(await sns.balanceOf(user1.address)).to.equal(0);
        expect(await sns.balanceOf(user2.address)).to.equal(1);
      });

      it('Should allow owner to transfer using safeTransferFrom', async function () {
        await expect(sns.connect(user1)['safeTransferFrom(address,address,uint256)'](user1.address, user2.address, tokenId))
            .to.emit(sns, 'Transfer')
            .withArgs(user1.address, user2.address, tokenId);
        expect(await sns.ownerOf(tokenId)).to.equal(user2.address);
        expect(await sns.resolve(name)).to.equal("original text");
      });

      it('Should allow approved address to transfer using transferFrom', async function () {
        await sns.connect(user1).approve(user2.address, tokenId);
        expect(await sns.getApproved(tokenId)).to.equal(user2.address);
        await expect(sns.connect(user2).transferFrom(user1.address, otherAccount.address, tokenId))
            .to.emit(sns, 'Transfer')
            .withArgs(user1.address, otherAccount.address, tokenId);
        expect(await sns.ownerOf(tokenId)).to.equal(otherAccount.address);
        expect(await sns.resolve(name)).to.equal("original text");
      });

       it('Should allow approved address to transfer using safeTransferFrom', async function () {
        await sns.connect(user1).approve(user2.address, tokenId);
        await expect(sns.connect(user2)['safeTransferFrom(address,address,uint256)'](user1.address, otherAccount.address, tokenId))
            .to.emit(sns, 'Transfer')
            .withArgs(user1.address, otherAccount.address, tokenId);
        expect(await sns.ownerOf(tokenId)).to.equal(otherAccount.address);
        expect(await sns.resolve(name)).to.equal("original text");
      });

      it('Should allow approved operator (setApprovalForAll) to transfer', async function () {
        await sns.connect(user1).setApprovalForAll(user2.address, true);
        expect(await sns.isApprovedForAll(user1.address, user2.address)).to.be.true;
        await expect(sns.connect(user2).transferFrom(user1.address, otherAccount.address, tokenId))
            .to.emit(sns, 'Transfer')
            .withArgs(user1.address, otherAccount.address, tokenId);
        expect(await sns.ownerOf(tokenId)).to.equal(otherAccount.address);
        expect(await sns.resolve(name)).to.equal("original text");
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
        await expect(sns.connect(user2).setTextRecord(tokenId, newText))
            .to.emit(sns, 'TextRecordUpdated')
            .withArgs(tokenId, newText);
        expect(await sns.resolve(name)).to.equal(newText);
        expect(await sns.tokenIdToTextRecord(tokenId)).to.equal(newText);
      });

      it('Should allow the new owner to renew after transfer', async function () {
         await sns.connect(user1).transferFrom(user1.address, user2.address, tokenId);
         expect(await sns.ownerOf(tokenId)).to.equal(user2.address);

         await time.increase(ONE_DAY * 10);
         const initialAsset = await sns.namesToAssets(name);
         const expectedTimestamp = BigInt(await time.latest()) + 1n;

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
   describe('Internal Helper Functions (toLower, isAlphanumeric)', function() {
       it('toLower works as expected (tested via registration/resolution)', async function() {
            const { sns, registerer, user1 } = await loadFixture(deploySessionNameServiceFixture);
            const nameUpper = "TESTNAME";
            const nameLower = "testname";
            const tokenId = calculateNameHash(nameLower);

            await sns.connect(registerer).registerName(user1.address, nameUpper);
            // Check resolution works for both cases
            expect(await sns.resolve(nameUpper)).to.equal(""); // Returns text record initially
            expect(await sns.resolve(nameLower)).to.equal(""); // Returns text record initially
            // Check internal storage used lowercase
            const linkedName = await sns.idsToNames(tokenId);
            expect(linkedName).to.equal(nameLower); // Compare directly to string
       });

       it('isAlphanumeric works as expected (tested via registration failures)', async function() {
            const { sns, registerer, user1 } = await loadFixture(deploySessionNameServiceFixture);
            // Valid chars
            await expect(sns.connect(registerer).registerName(user1.address, "valid123name")).to.not.be.reverted;
            // Burn it to allow next test
            await sns.connect(user1).burn(calculateNameHash("valid123name"));

            // Invalid chars
            await expect(sns.connect(registerer).registerName(user1.address, "invalid!"))
                .to.be.revertedWithCustomError(sns, 'UnsupportedCharacters');
            await expect(sns.connect(registerer).registerName(user1.address, "invalid space"))
                .to.be.revertedWithCustomError(sns, 'UnsupportedCharacters');
            await expect(sns.connect(registerer).registerName(user1.address, "invalid-dash"))
                .to.be.revertedWithCustomError(sns, 'UnsupportedCharacters');
             await expect(sns.connect(registerer).registerName(user1.address, "你好")) // Non-ascii
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
      expect(await sns.resolve(TEST_NAME_1)).to.equal("");
    });

    it('Should allow the owner to set the text record', async function () {
      await expect(sns.connect(user1).setTextRecord(tokenId, testText))
        .to.emit(sns, 'TextRecordUpdated')
        .withArgs(tokenId, testText);
      expect(await sns.tokenIdToTextRecord(tokenId)).to.equal(testText);
      expect(await sns.resolve(TEST_NAME_1)).to.equal(testText); // Resolve should now return the text
    });

    it('Should allow an approved address to set the text record', async function () {
      const testText = "approved text";
      await sns.connect(user1).approve(user2.address, tokenId);
      await expect(sns.connect(user2).setTextRecord(tokenId, testText))
        .to.emit(sns, 'TextRecordUpdated')
        .withArgs(tokenId, testText);
      expect(await sns.tokenIdToTextRecord(tokenId)).to.equal(testText);
      expect(await sns.resolve(TEST_NAME_1.toLowerCase())).to.equal(testText); // Resolve uses lowercase name
    });

     it('Should allow an approved operator (setApprovalForAll) to set the text record', async function () {
      await sns.connect(user1).setApprovalForAll(user2.address, true);
      await expect(sns.connect(user2).setTextRecord(tokenId, testText))
        .to.emit(sns, 'TextRecordUpdated')
        .withArgs(tokenId, testText);
      expect(await sns.tokenIdToTextRecord(tokenId)).to.equal(testText);
      expect(await sns.resolve(TEST_NAME_1)).to.equal(testText);
    });

    it('Should prevent non-owner/non-approved from setting the text record', async function () {
      // Using registerer account (not owner or approved)
      await expect(sns.connect(registerer).setTextRecord(tokenId, testText))
        .to.be.revertedWithCustomError(sns, 'NotAuthorized');
      // Using other account (not owner or approved)
      await expect(sns.connect(otherAccount).setTextRecord(tokenId, testText))
        .to.be.revertedWithCustomError(sns, 'NotAuthorized');
    });

     it('Should prevent setting the text record for a non-existent token', async function () {
      const nonExistentTokenId = calculateNameHash("nonexistent");
      await expect(sns.connect(user1).setTextRecord(nonExistentTokenId, testText))
            .to.be.revertedWithCustomError(sns, 'ERC721NonexistentToken')
            .withArgs(nonExistentTokenId);
     });

    it('Should allow setting an empty text record', async function () {
       // Set it first
      await sns.connect(user1).setTextRecord(tokenId, testText);
      expect(await sns.resolve(TEST_NAME_1)).to.equal(testText);
      // Set it back to empty
      await expect(sns.connect(user1).setTextRecord(tokenId, ""))
        .to.emit(sns, 'TextRecordUpdated')
        .withArgs(tokenId, "");
      expect(await sns.tokenIdToTextRecord(tokenId)).to.equal("");
      expect(await sns.resolve(TEST_NAME_1)).to.equal("");
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

    it('Should increment totalSupply correctly with registerNameMultiple', async function () {
      const { sns, registerer, user1, user2, otherAccount } = await loadFixture(deploySessionNameServiceFixture);
      expect(await sns.totalSupply()).to.equal(0);
      const names = ['multi1', 'multi2', 'multi3'];
      const addresses = [user1.address, user2.address, otherAccount.address];

      await sns.connect(registerer).registerNameMultiple(addresses, names);
      expect(await sns.totalSupply()).to.equal(names.length);
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
});
