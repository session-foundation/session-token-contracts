// This script registers a name using the SessionNameService contract.
// It requires the contract address and the name to register.
//
const hre = require("hardhat");
const chalk = require("chalk");

const ethers = hre.ethers;

async function main() {
  [owner] = await ethers.getSigners();
  // These values should be updated for your specific deployment
  const SESSION_NAME_SERVICE_ADDRESS = "0xF698CCF07208D14288c4A92E0bE9930D6F41BD7c"; // Replace with your deployed contract address
  //const NAME_TO_REGISTER = "example"; // Replace with the name you want to register
  const NAME_TO_REGISTER = "rRpbk0XnuO7dI5tuD1DCPifYwnIpTTYeI8TEyAYkCdM="; // Replace with the name you want to register
  const RECIPIENT_ADDRESS = await owner.getAddress(); // Replace with the address that should own the name
  const TEXT_RECORD = "Hello from a hashsed Session Name Service name - sean!"; // Text record to set for the name

  const args = {
    SESSION_NAME_SERVICE_ADDRESS,
    NAME_TO_REGISTER,
    RECIPIENT_ADDRESS,
    TEXT_RECORD,
  };

  await registerSessionName(args);
}

async function registerSessionName(args = {}) {
  [owner] = await ethers.getSigners();
  const ownerAddress = await owner.getAddress();

  const networkName = hre.network.name;
  console.log("Registering Session name on network:", chalk.yellow(networkName));

  const SESSION_NAME_SERVICE_ADDRESS = args.SESSION_NAME_SERVICE_ADDRESS;
  const NAME_TO_REGISTER = args.NAME_TO_REGISTER;
  const RECIPIENT_ADDRESS = args.RECIPIENT_ADDRESS || ownerAddress;
  const TEXT_RECORD = args.TEXT_RECORD || "";

  if (!SESSION_NAME_SERVICE_ADDRESS || SESSION_NAME_SERVICE_ADDRESS === "0x...") {
    console.error(
      chalk.red("Error: SessionNameService contract address is not set."),
    );
    console.error(
      "Please update the SESSION_NAME_SERVICE_ADDRESS constant in this script.",
    );
    process.exit(1);
  }

  if (!NAME_TO_REGISTER || NAME_TO_REGISTER === "example") {
    console.error(
      chalk.red("Error: Name to register is not set."),
    );
    console.error(
      "Please update the NAME_TO_REGISTER constant in this script.",
    );
    process.exit(1);
  }

  // Get the contract instance
  const SessionNameService = await ethers.getContractFactory("SessionNameService");
  const sessionNameService = SessionNameService.attach(SESSION_NAME_SERVICE_ADDRESS);

  console.log(
    "  ",
    chalk.cyan(`SessionNameService Contract`),
    "at:",
    chalk.greenBright(SESSION_NAME_SERVICE_ADDRESS),
  );
  console.log(
    "  ",
    "Registering name:",
    chalk.green(NAME_TO_REGISTER),
    "for address:",
    chalk.green(RECIPIENT_ADDRESS),
  );
  console.log(
    "  ",
    "Text record to set:",
    chalk.green(TEXT_RECORD || "(empty)"),
  );

  try {
    // Register the name
    const tx = await sessionNameService.registerName(RECIPIENT_ADDRESS, NAME_TO_REGISTER);
    console.log("Registration transaction sent:", chalk.yellow(tx.hash));
    
    // Wait for the transaction to be mined
    const receipt = await tx.wait();
    console.log("Registration confirmed in block:", chalk.green(receipt.blockNumber));
    
    // Get the token ID for the registered name
    const nameHash = ethers.keccak256(ethers.toUtf8Bytes(NAME_TO_REGISTER.toLowerCase()));
    const tokenId = BigInt(nameHash);
    
    console.log(
      "  ",
      chalk.green("Successfully registered name:"),
      chalk.cyan(NAME_TO_REGISTER),
      "with token ID:",
      chalk.green(tokenId.toString()),
    );
    
    // Check if the name is correctly assigned to the recipient
    const nameOwner = await sessionNameService.ownerOf(tokenId);
    console.log(
      "  ",
      "Name owner verified:",
      chalk.green(nameOwner),
    );
    
    // Set the text record if provided
    if (TEXT_RECORD) {
      console.log(chalk.yellow("\n--- Setting Text Record ---\n"));
      
      // Check if the caller is the owner or has approval
      if (nameOwner.toLowerCase() !== ownerAddress.toLowerCase()) {
        console.log("Checking if caller has approval to set text record...");
        const isApproved = await sessionNameService.isApprovedForAll(nameOwner, ownerAddress);
        if (!isApproved) {
          console.error(
            chalk.red("Error: The caller is not the owner and does not have approval to set the text record."),
          );
          console.error(
            "Please ensure the caller is the owner or has been approved to set the text record.",
          );
          process.exit(1);
        }
      }
      
      // Set the text record
      const setTextTx = await sessionNameService.setTextRecord(tokenId, TEXT_RECORD);
      console.log("Text record transaction sent:", chalk.yellow(setTextTx.hash));
      
      // Wait for the transaction to be mined
      const setTextReceipt = await setTextTx.wait();
      console.log("Text record confirmed in block:", chalk.green(setTextReceipt.blockNumber));
      
      // Verify the text record was set correctly
      const updatedTextRecord = await sessionNameService.resolve(NAME_TO_REGISTER);
      console.log(
        "  ",
        "Text record verified:",
        chalk.green(updatedTextRecord),
      );
    } else {
      // Get the text record (should be empty by default)
      const textRecord = await sessionNameService.resolve(NAME_TO_REGISTER);
      console.log(
        "  ",
        "Text record:",
        chalk.green(textRecord || "(empty)"),
      );
    }
    
  } catch (error) {
    console.error("Failed to register name or set text record:", error);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}); 
