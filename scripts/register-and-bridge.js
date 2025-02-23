// This script registers the L1 token with its L2 counterpart using the Arbitrum custom gateway
// and then bridges over some tokens via the custom bridge.
// It assumes that the tokens are already deployed and that the necessary gateway addresses are hardcoded.
const hre = require("hardhat");
const chalk = require("chalk");
const ethers = hre.ethers;


async function main() {
  const SESH_DECIMALS = 9;
  const SESH_TO_TRANSFER = "200000000";

  // Hardcoded addresses
  console.error("TODO: Token Address needs to be updated with the L1 and L2 address, THIS SCRIPT WILL FAIL");
  // TODO Replace with actual addresses for the L2 gateway and L1 counterpart
  const L1_TOKEN_ADDRESS = "0xL1TokenAddress";
  const L2_TOKEN_ADDRESS = "0xL2TokenAddress";

  const L1_GATEWAY_ROUTER_ADDRESS = "0x72Ce9c846789fdB6fC1f34aC4AD25Dd9ef7031ef"; // https://github.com/OffchainLabs/arbitrum-sdk/blob/9326101b86353f9459767a221eaa0c733218e2fa/packages/sdk/src/lib/dataEntities/networks.ts#L160
  const L1_CUSTOM_GATEWAY_ADDRESS = "0xcEe284F754E854890e311e3280b767F80797180d"; // https://github.com/OffchainLabs/arbitrum-sdk/blob/9326101b86353f9459767a221eaa0c733218e2fa/packages/sdk/src/lib/dataEntities/networks.ts#L164

  const [owner] = await ethers.getSigners();
  const ownerAddress = await owner.getAddress();
  console.log(chalk.green(`Using deployer: ${ownerAddress}`));

  // Constants
  const feeData = await owner.provider.getFeeData();
  const l1GasPriceBid = feeData.gasPrice ? feeData.gasPrice * BigInt(2) : ethers.parseUnits('10', 'gwei');
  const l2GasPriceBid = BigInt("1000000000");
  const maxGasForCustomGateway = BigInt(1000000);
  const maxGasForRouter = BigInt(500000);
  const maxSubmissionCostForCustomGateway = BigInt("500000000000000");
  const maxSubmissionCostForRouter = BigInt("300000000000000");
  const gatewayGasCost = maxGasForCustomGateway * l2GasPriceBid;
  const routerGasCost = maxGasForRouter * l2GasPriceBid;
  const valueForGateway = maxSubmissionCostForCustomGateway + gatewayGasCost;
  const valueForRouter = maxSubmissionCostForRouter + routerGasCost;
  const totalValue = valueForGateway + valueForRouter;
  
  console.log(chalk.blue("\nRegistering L1 token to L2 token..."));
  
  const registerTokenABI = [
    "function registerTokenOnL2(address l2CustomTokenAddress, uint256 maxSubmissionCostForCustomGateway, uint256 maxSubmissionCostForRouter, uint256 maxGasForCustomGateway, uint256 maxGasForRouter, uint256 gasPriceBid, uint256 valueForGateway, uint256 valueForRouter, address creditBackAddress) payable"
  ];
  
  const l1Token = new ethers.Contract(
    L1_TOKEN_ADDRESS,
    registerTokenABI,
    owner
  );
  
  try {
    console.log("Transaction parameters:");
    console.log(`L2 Token Address: ${L2_TOKEN_ADDRESS}`);
    console.log(`Max Submission Cost (Gateway): ${maxSubmissionCostForCustomGateway}`);
    console.log(`Max Submission Cost (Router): ${maxSubmissionCostForRouter}`);
    console.log(`Max Gas (Gateway): ${maxGasForCustomGateway}`);
    console.log(`Max Gas (Router): ${maxGasForRouter}`);
    console.log(`Gas Price Bid: ${l2GasPriceBid}`);
    console.log(`Value For Gateway: ${valueForGateway}`);
    console.log(`Value For Router: ${valueForRouter}`);
    console.log(`Total Value: ${totalValue}`);
    
    const registerTx = await l1Token.registerTokenOnL2(
      L2_TOKEN_ADDRESS,
      maxSubmissionCostForCustomGateway,
      maxSubmissionCostForRouter,
      maxGasForCustomGateway,
      maxGasForRouter,
      l2GasPriceBid,
      valueForGateway,
      valueForRouter,
      ownerAddress,
      { value: totalValue }
    );
    
    console.log("Registration transaction submitted, waiting for confirmation...");
    const registerReceipt = await registerTx.wait();
    console.log(chalk.green(`Token registration successful: ${registerReceipt.transactionHash}`));
  } catch (error) {
    console.error(chalk.red("Error during token registration:"), error);
    process.exit(1);
  }

  // --- Bridging Tokens over to L2 ---
  console.log(chalk.blue("\nInitiating token bridge via the custom bridge..."));

  // Parameters for the bridge function
  const l1MaxGas = BigInt(300000);
  const l2MaxGas = BigInt(1000000);
  const maxSubmissionCost = BigInt("500000000000000");
  const callHookData = "0x";
  const l2amount = ethers.parseEther("0.002");
  const totalL2GasCost = l2MaxGas * l2GasPriceBid;
  const totalL2Value = maxSubmissionCost + totalL2GasCost + l2amount;
  const extraData = ethers.AbiCoder.defaultAbiCoder().encode(
  ["uint256", "bytes"],
  [maxSubmissionCost, callHookData]
  );

  // Approve the token for the gateway transfer.
  const depositAmount = ethers.parseUnits(SESH_TO_TRANSFER, SESH_DECIMALS);
  console.log(`Approving ${SESH_TO_TRANSFER} tokens for the L1 Gateway...`);
  const erc20ABI = [
    "function approve(address spender, uint256 amount) external returns (bool)"
  ];
  const l1TokenContract = new ethers.Contract(L1_TOKEN_ADDRESS, erc20ABI, owner);
  try {
    const approveTx = await l1TokenContract.approve(L1_CUSTOM_GATEWAY_ADDRESS, depositAmount);
    await approveTx.wait();
    console.log(chalk.green("Token approval complete."));
  } catch (error) {
    console.error(chalk.red("Error during token approval:"), error);
    process.exit(1);
  }


  console.log("Initiating outbound transfer on the custom bridge...");
  const l1GatewayRouterABI = [
     "function outboundTransferCustomRefund(address _token, address _refundTo, address _to, uint256 _amount, uint256 _maxGas, uint256 _gasPriceBid, bytes calldata _data) external payable returns (bytes memory)",
  ];

  const l1GatewayRouter = new ethers.Contract(
     L1_GATEWAY_ROUTER_ADDRESS,
     l1GatewayRouterABI,
     owner
  );

  try {
    const outboundTx = await l1GatewayRouter.outboundTransferCustomRefund(
      L1_TOKEN_ADDRESS,
      ownerAddress,   // refund recipient
      ownerAddress,   // destination on L2
      depositAmount,
      l2MaxGas,
      l2GasPriceBid,
      extraData,
      {
        gasLimit: l1MaxGas,
        gasPrice: l1GasPriceBid,
        value: totalL2Value,
      }
    );
    console.log("Outbound transfer transaction submitted, waiting for confirmation...");
    const receipt = await outboundTx.wait();
    console.log(chalk.green(`Outbound transfer successful: ${receipt.hash}`));
    console.log(`Track the retryable ticket here: https://retryable-dashboard.arbitrum.io/tx/${receipt.hash}`);
  } catch (error) {
    console.error(chalk.red("Error during outbound transfer:"), error);
    process.exit(1);
  }

  console.log(chalk.green("\nToken registration and bridging complete."));
}

main().catch((error) => {
  console.error(chalk.red("Script encountered an error:"), error);
  process.exitCode = 1;
});

