const hre = require("hardhat");
const fs = require('fs');
const chalk = require('chalk');

// Constants
const seshAddress = "0x6C9D6d6FB69927e3CED37374d820121c7c5b77e1";
// Load this jsonFilePath based on what is output when running deploy-investor-vesting.js script. Its default
// output path is: `deployments/vesting-${networkName}-${Date.now()}.json`
const jsonFilePath = "./deployments/vesting-sepolia-1747608242040.json";

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  console.log("Transferring tokens with account:", chalk.yellow(deployer.address));

  const networkName = hre.network.name;
  console.log("Network:", chalk.cyan(networkName));
  console.log("SESH token address:", chalk.yellow(seshAddress));
  console.log("JSON file:", chalk.yellow(jsonFilePath));

  if (!fs.existsSync(jsonFilePath)) {
    console.error(chalk.red(`Error: JSON file not found at ${jsonFilePath}`));
    process.exit(1);
  }

  if (!hre.ethers.isAddress(seshAddress)) {
    console.error(chalk.red(`Error: Invalid SESH token address: ${seshAddress}`));
    process.exit(1);
  }

  const fileContent = fs.readFileSync(jsonFilePath, 'utf8');
  let deployments;
  
  try {
    deployments = JSON.parse(fileContent);
  } catch (error) {
    console.error(chalk.red(`Error parsing JSON file: ${error.message}`));
    process.exit(1);
  }

  if (!deployments || !Array.isArray(deployments['contracts']) || deployments['contracts'].length === 0) {
    console.error(chalk.red("Error: JSON file is empty or invalid"));
    process.exit(1);
  }

  const seshContract = await hre.ethers.getContractAt("SESH", seshAddress);
  
  const deployerBalance = await seshContract.balanceOf(deployer.address);
  const totalRequired = deployments['contracts'].reduce((sum, deployment) => {
    return sum + hre.ethers.parseUnits(deployment.amount, 9); // Assuming 9 decimals for SESH
  }, 0n);

  console.log("Your balance:", chalk.yellow(hre.ethers.formatUnits(deployerBalance, 9)), "SESH");
  console.log("Total required:", chalk.yellow(hre.ethers.formatUnits(totalRequired, 9)), "SESH");

  if (deployerBalance < totalRequired) {
    console.error(chalk.red("Error: Insufficient SESH balance for transfers"));
    console.error(`You have ${hre.ethers.formatUnits(deployerBalance, 9)} SESH, but need ${hre.ethers.formatUnits(totalRequired, 9)} SESH`);
    process.exit(1);
  }

  console.log(chalk.yellow("Starting transfers...\n"));

  let successful = 0;
  let failed = 0;
  
  for (const deployment of deployments['contracts']) {
    try {
      if (!hre.ethers.isAddress(deployment['vestingAddress'])) {
        throw new Error(`Invalid vesting contract address: ${deployment['vestingAddress']}`);
      }

      const amount = hre.ethers.parseUnits(deployment['amount'], 9); // Assuming 9 decimals for SESH
      console.log(chalk.cyan(`Transferring ${deployment['amount']} SESH to ${deployment['vestingAddress']}...`));
      
      const transferTx = await seshContract.transfer(deployment['vestingAddress'], amount);
      await transferTx.wait();
      
      console.log(chalk.green("✓ Transfer successful! Tx hash:"), transferTx.hash);
      successful++;
    } catch (error) {
      console.error(chalk.red(`Error transferring to ${deployment['vestingAddress']}:`), error.message);
      failed++;
    }
  }

  console.log(chalk.cyan("\nTransfer Summary:"));
  console.log("Total contracts:", chalk.yellow(deployments['contracts'].length));
  console.log("Successful:", chalk.green(successful));
  console.log("Failed:", failed > 0 ? chalk.red(failed) : chalk.green(failed));
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(chalk.red("Unhandled error:"));
    console.error(error);
    process.exit(1);
  }); 
