// This script deploys the SessionNameService contract, which is an ERC721-based
// name service for Session. It sets up the base URI for token metadata.
//
const hre = require("hardhat");
const chalk = require("chalk");

const ethers = hre.ethers;

async function main() {
  // Base URI for token metadata - this should be updated to your actual metadata URI
  const BASE_URI = "https://api.getsession.org/sns/metadata/";

  const args = {
    BASE_URI,
  };

  await deploySessionNameService(args);
}

async function deploySessionNameService(args = {}, verify = true) {
  [owner] = await ethers.getSigners();
  const ownerAddress = await owner.getAddress();

  const networkName = hre.network.name;
  console.log("Deploying SessionNameService contract to:", chalk.yellow(networkName));

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

  const BASE_URI = args.BASE_URI;

  const SessionNameService = await ethers.getContractFactory("SessionNameService", owner);
  let sessionNameService;

  try {
    sessionNameService = await SessionNameService.deploy(BASE_URI);
  } catch (error) {
    console.error("Failed to deploy SessionNameService contract:", error);
    process.exit(1);
  }

  console.log(
    "  ",
    chalk.cyan(`SessionNameService Contract`),
    "deployed to:",
    chalk.greenBright(await sessionNameService.getAddress()),
    "on network:",
    chalk.yellow(networkName),
  );
  console.log(
    "  ",
    "Base URI set to:",
    chalk.green(BASE_URI),
  );
  await sessionNameService.waitForDeployment();

  if (verify) {
    console.log(chalk.yellow("\n--- Verifying SessionNameService ---\n"));
    console.log("Waiting 6 confirmations to ensure etherscan has processed tx");
    await sessionNameService.deploymentTransaction().wait(6);
    console.log("Finished Waiting");
    try {
      await hre.run("verify:verify", {
        address: await sessionNameService.getAddress(),
        constructorArguments: [BASE_URI],
        contract: "contracts/SessionNameService.sol:SessionNameService",
        force: true,
      });
    } catch (error) {
      console.error(chalk.red("Verification failed:"), error);
    }
    console.log(chalk.green("Contract verification complete."));
  }

  return { sessionNameService };
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}); 