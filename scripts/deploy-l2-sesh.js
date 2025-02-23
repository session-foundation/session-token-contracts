// This script deploys the L2 version of the SESH token, it sets up the Addresses 
// of the Arbitrum Custom Gateway which are specified on deployment.
//
// This script is the second to be run, but it needs the L1 Token Address from the
// token deployed in deploy-l1-sesh script
const hre = require("hardhat");
const chalk = require("chalk");

async function main() {

  console.error("TODO: Token Address needs to be updated with the L1 address from deploy-l1-sesh, THIS SCRIPT WILL FAIL");
  // TODO Replace with actual addresses for the L2 gateway and L1 counterpart
  const L1_TOKEN_ADDRESS = "0xTODOREPLACEMEWITHDEPLOYEDL1TOKENADDRESS";
  const L2_GATEWAY_ADDRESS = "0x096760F208390250649E3e8763348E783AEF5562"; // https://github.com/OffchainLabs/arbitrum-sdk/blob/9326101b86353f9459767a221eaa0c733218e2fa/packages/sdk/src/lib/dataEntities/networks.ts#L165C24-L165C66

  const args = {
    L2_GATEWAY_ADDRESS,
    L1_TOKEN_ADDRESS,
  };

  await deploySESHL2(args);
}

async function deploySESHL2(args = {}, verify = true) {
  const [owner] = await hre.ethers.getSigners();
  const ownerAddress = await owner.getAddress();
  const networkName = hre.network.name;

  console.log("Deploying SESHL2 proxy contract to:", chalk.yellow(networkName));

  // Check for a valid API key in the Hardhat config (for verification)
  if (verify) {
    let apiKey;
    if (typeof hre.config.etherscan?.apiKey === "object") {
      apiKey = hre.config.etherscan.apiKey[networkName];
    } else {
      apiKey = hre.config.etherscan?.apiKey;
    }
    if (!apiKey || apiKey === "") {
      console.error(
        chalk.red("Error: API key for contract verification is missing.")
      );
      console.error(
        "Please set it in your Hardhat configuration under 'etherscan.apiKey'."
      );
      process.exit(1);
    }
  }

  const L2_GATEWAY_ADDRESS = args.L2_GATEWAY_ADDRESS;
  const L1_TOKEN_ADDRESS = args.L1_TOKEN_ADDRESS;

  const SESHL2 = await hre.ethers.getContractFactory("SESHL2", owner);

  let seshl2Proxy;
  try {
    seshl2Proxy = await hre.upgrades.deployProxy(
      SESHL2,
      [L2_GATEWAY_ADDRESS, L1_TOKEN_ADDRESS]
    );
  } catch (error) {
    console.error("Failed to deploy SESHL2 proxy contract:", error);
    process.exit(1);
  }

  console.log(
    "  ",
    chalk.cyan("SESHL2 Proxy Contract"),
    "deployed to:",
    chalk.greenBright(await seshl2Proxy.getAddress()),
    "on network:",
    chalk.yellow(networkName)
  );
  console.log("  ", "Deployment transaction sender:", chalk.green(ownerAddress));
  await seshl2Proxy.waitForDeployment();

  if (verify) {
    console.log(chalk.yellow("\n--- Verifying SESHL2 Implementation ---\n"));
    console.log("Waiting 6 confirmations to ensure etherscan has processed tx");
    await seshl2Proxy.deploymentTransaction().wait(6);
    console.log("Finished Waiting");
    try {
      await hre.run("verify:verify", {
        address: await seshl2Proxy.getAddress(),
        constructorArguments: [],
        contract: "contracts/SESHL2.sol:SESHL2",
        force: true,
      });
    } catch (error) {
      console.error(chalk.red("Verification failed:"), error);
    }
    console.log(chalk.green("Contract verification complete."));
  }
  return { seshl2Proxy };
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

