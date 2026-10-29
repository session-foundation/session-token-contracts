const hre = require("hardhat");
const { ethers, upgrades } = require('hardhat');
const chalk = require('chalk');

async function main() {
  // Address of the proxy contract to upgrade - replace with your deployed proxy address
  const PROXY_ADDRESS = "REPLACE_WITH_YOUR_DEPLOYED_PROXY_ADDRESS";

  const networkName = hre.network.name;
  console.log("Upgrading SessionNameService contract on:", chalk.yellow(networkName));

  // Ensure we have API key to verify
  let apiKey;
  if (typeof hre.config.etherscan?.apiKey === 'object') {
    apiKey = hre.config.etherscan.apiKey[networkName];
  } else {
    apiKey = hre.config.etherscan?.apiKey;
  }
  if (!apiKey || apiKey == "") {
    console.error(chalk.red("Error: API key for contract verification is missing."));
    console.error("Please set it in your Hardhat configuration under 'etherscan.apiKey'.");
    process.exit(1); // Exit with an error code
  }

  // Get the SessionNameService factory
  const SessionNameService = await ethers.getContractFactory("SessionNameService");
  console.log('Upgrading SessionNameService proxy...');
  
  try {
    // Perform the upgrade
    const sessionNameService = await upgrades.upgradeProxy(PROXY_ADDRESS, SessionNameService);
    console.log('SessionNameService upgraded successfully');
    
    // Get the new implementation address
    const implementationAddress = await upgrades.erc1967.getImplementationAddress(
      await sessionNameService.getAddress()
    );
    console.log("New implementation address:", chalk.greenBright(implementationAddress));

    // Verify the new implementation
    console.log(chalk.yellow("\n--- Verifying new SessionNameService implementation ---\n"));
    await sessionNameService.waitForDeployment();
    try {
      await hre.run("verify:verify", {
        address: implementationAddress,
        constructorArguments: [],
        contract: "contracts/SessionNameService.sol:SessionNameService",
        force: true,
      });
      console.log(chalk.green("Contract verification complete."));
    } catch (error) {
      console.error(chalk.red("Verification failed:"), error);
    }
  } catch (error) {
    console.error("Failed to upgrade SessionNameService:", error);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}); 