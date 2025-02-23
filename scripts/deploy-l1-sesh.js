// This script deploys the L1 version of the SESH token, it sets up the Addresses 
// of the Arbitrum Router and Custom Gateway which are specified on deployment.
//
// This script is the first to be run
const hre = require("hardhat");
const chalk = require("chalk");

const ethers = hre.ethers;

async function main() {
  const SESH_UNIT = 1_000_000_000n;
  const SUPPLY = 240_000_000n * SESH_UNIT;

  // These are set to the mainnet arbitrum values
  const L1_ROUTER_ADDRESS = "0x72Ce9c846789fdB6fC1f34aC4AD25Dd9ef7031ef"; // https://github.com/OffchainLabs/arbitrum-sdk/blob/9326101b86353f9459767a221eaa0c733218e2fa/packages/sdk/src/lib/dataEntities/networks.ts#L160
  const L1_GATEWAY_ADDRESS = "0xcEe284F754E854890e311e3280b767F80797180d"; // https://github.com/OffchainLabs/arbitrum-sdk/blob/9326101b86353f9459767a221eaa0c733218e2fa/packages/sdk/src/lib/dataEntities/networks.ts#L164

  const args = {
    SESH_UNIT,
    SUPPLY,
    L1_GATEWAY_ADDRESS,
    L1_ROUTER_ADDRESS,
  };

  await deploySESH(args);
}

async function deploySESH(args = {}, verify = true) {
  [owner] = await ethers.getSigners();
  const ownerAddress = await owner.getAddress();

  const networkName = hre.network.name;
  console.log("Deploying SESH contract to:", chalk.yellow(networkName));

  if (verify) {
    let apiKey;
    if (typeof hre.config.etherscan?.apiKey === "object") {
      apiKey = hre.config.etherscan.apiKey[networkName];
    } else {
      apiKey = hre.config.etherscan?.apiKey;
    }
    if (!apiKey || apiKey == "") {
      console.error(
        chalk.red("Error: API key for contract verification is missing."),
      );
      console.error(
        "Please set it in your Hardhat configuration under 'etherscan.apiKey'.",
      );
      process.exit(1);
    }
  }

  const SESH_UNIT = args.SESH_UNIT || 1_000_000_000n;
  const SUPPLY = args.SUPPLY || 240_000_000n * SESH_UNIT;
  const L1_GATEWAY_ADDRESS = args.L1_GATEWAY_ADDRESS;
  const L1_ROUTER_ADDRESS = args.L1_ROUTER_ADDRESS;

  const SeshERC20 = await ethers.getContractFactory("SESH", owner);
  let seshERC20;

  try {
    seshERC20 = await SeshERC20.deploy(SUPPLY, ownerAddress, L1_GATEWAY_ADDRESS, L1_ROUTER_ADDRESS);
  } catch (error) {
    console.error("Failed to deploy SESH contract:", error);
    process.exit(1);
  }

  console.log(
    "  ",
    chalk.cyan(`SESH Contract`),
    "deployed to:",
    chalk.greenBright(await seshERC20.getAddress()),
    "on network:",
    chalk.yellow(networkName),
  );
  console.log(
    "  ",
    "Initial Supply will be received by:",
    chalk.green(ownerAddress),
  );
  await seshERC20.waitForDeployment();

  if (verify) {
    console.log(chalk.yellow("\n--- Verifying SESH ---\n"));
    console.log("Waiting 6 confirmations to ensure etherscan has processed tx");
    await seshERC20.deploymentTransaction().wait(6);
    console.log("Finished Waiting");
    try {
      await hre.run("verify:verify", {
        address: await seshERC20.getAddress(),
        constructorArguments: [SUPPLY, ownerAddress, L1_GATEWAY_ADDRESS, L1_ROUTER_ADDRESS],
        contract: "contracts/SESH.sol:SESH",
        force: true,
      });
    } catch (error) {
      console.error(chalk.red("Verification failed:"), error);
    }
    console.log(chalk.green("Contract verification complete."));
  }

  return { seshERC20 };
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

