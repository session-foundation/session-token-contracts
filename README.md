# Session Token Rewards Contract

This contract is designed to facilitate the integration and functioning of the
Session Token within the oxen network. The core of the codebase is now split
into two components: the existing C++ codebase, which handles various service
node responsibilities like uptime tracking, reward calculations, and other
duties; and the new smart contract system, which includes the Session Token
contract and this rewards contract.

The rewards contract manages the dynamics of nodes within the network. It
handles various crucial operations such as the admission of node operators
through stake deposits, broadcasting new node details across the network via
events/logs, managing the exit of stakers with an associated unlock period, and
the distribution of earned rewards. One of the key features of the rewards
contract is its use of BLS signatures. This technology enables the aggregation
of multiple signatures into a single, verifiable entity, ensuring that rewards
are distributed only when a consensus (e.g., 95% agreement within the network)
is achieved regarding the amount to be claimed.

## Building and Tests

There are 3 testing frameworks in use,

  - Javascript: Unit tests via Hardhat
  - C++: Integration tests via RPC over a devnet (like a local `hardhat node`)
  - Echidna: Fuzz testing of the smart contract over a devnet

### Javascript

Contracts can be compiled and tested against unit tests run by executing:

```
npm install -g pnpm            # If you don't have pnpm installed yet
pnpm install --frozen-lockfile # Install the dependencies
pnpm build                     # Build the JS unit-tests and Solidity contracts
pnpm test                      # Run the JS unit-tests
```

### C++

Integration tests require running a devnet first with the deployed smart
contracts followed by running the C++ tests which will communicate with the
given network. First setup the devnet:

```
make node         # Run the local devnet (note: This blocks the terminal)
make deploy-local # Deploy the smart contracts onto the devnet
```

Then execute the C++ tests by compilin and running, for example:

```
cd test/cpp/
cmake -B build -S .
cmake --build build --parallel --verbose

# Run the tests
./test/cpp/build/test/rewards_contract_Tests
```

### Echidna

Get [echidna](https://github.com/crytic/echidna) and place it onto your path.
Echidna also relies on [slither](https://github.com/crytic/slither) a static
analyzer that uses Python 3 and hence can be installed via
`python -m pip install slither-analyzer`.

Fuzz testing may then be run by executing:

```
make node # Run the local devnet (note: This blocks the terminal)
echidna . --contract ServiceNodeContributionEchidnaTest --config echidna-local.config.yml

# Or alternatively via the make target

make fuzz
```

We run Echidna in `assertion` testing mode which allows echidna to simulate
multiple senders (because our contracts can potentially use multiple wallets).
`property` testing mode simulates the transactions as if they were originating
from the smart contract which is not as useful for testing our contracts.

### Slither

You can run `slither` a static analyzer separately from Echidna by executing:

```
make analyze
```

## Scripts

- `scripts/attach-and-dump-sn-rewards-stats.js`

  Attaches to the `ServiceNodeRewards` instance specified in the script and
  dumps the current state of the contract. This script is RPC heavy as it
  scrapes contributors and service nodes information which currently is done
  with 1 request per entry.

  This script can be run via hardhat, e.g:

    npx hardhat run --network arbitrumSepolia scripts/attach-and-dump-sn-rewards-stats.js

## Mainnet Architecture

The mainnet contracts are deployed on Arbitrum at the following addresses and
are all using the upgradeable pattern. This means the contract "address" is a
proxy contract that forwards input data to the concrete implementation of the
contract. Admins can change which contract the proxy points to which is the
typical path you'd undertake to upgrade a contract.

**Service Node Rewards Contract**
 - Address: [0xC2B9fC251aC068763EbDfdecc792E3352E351c00](https://arbiscan.io/address/0xC2B9fC251aC068763EbDfdecc792E3352E351c00)
 - Proxy Admin Contract: [0x947E232e91D53b4f02883971D04C5A21387b15D7](https://arbiscan.io/address/0x947E232e91D53b4f02883971D04C5A21387b15D7)

This contract manages the list of Session nodes. By connecting a wallet to the
[staking portal](https://stake.getsession.org) and managing your Session node
stake, the portal submits transactions to this address to enter or exit the
Session node list as well as to lock or claim $SESH tokens from participating in
the network.

In participating in the network with their stake, users slowly accrue owed $SESH
tokens which they claim from the $SESH balance held in the contract. These
tokens are emitted from the Reward Rate Pool contract at an approximate rate of
14% per annum.

Administrative actions on the contract require 2/3rds of the network to
produce an aggregate signature from the network or otherwise the
[blsNonSignerThreshold](https://arbiscan.io/address/0xC2B9fC251aC068763EbDfdecc792E3352E351c00#readProxyContract#F10)
blocks the action from taken. In other words the
contract has well defined behaviour and funds and exiting can occur if more than
2/3rds of the network is participating in the network (this essentially includes
all operations that have the modifier `hasEnoughSigners`) on them.

Actions on this contract emit events which are responded to by the Session node
network which is committing and coming to consensus on the
[oxen-core](https://github.com/oxen-io/oxen-core) side chain which contains all
the meta state to generate the aggregate signatures, penalise nodes and so
forth outside of Arbitrum.

Periodically the network needs to be flushed of inactive nodes if operators
themselves do not formally exit their nodes from the network after the 15 day
period has elapsed since requesting to exit the network. Operators/contributors
have 7 days (dictated by
[ETH_DEREG_BUFFER](https://github.com/oxen-io/oxen-core/blob/717d02f5ed06bc5a02d598c77e1f5e36a2f66502/src/network_config/mainnet.h#L85)
in `oxen-core`) to exit the network or otherwise these nodes can be forcibly
removed which we dub as liquidation of the node and incur a penalty on their
stake for doing so that is rewarded to the liquidator.

Failure to exit nodes in a timely manner leads to degraded services on the
network and impacts the BLS signing process. If more than 1/3rd of the network
registered or has an exit initiated but have not formally exited the network may
cause signing issues if nodes are not being liquidated to keep the composition
of nodes in the network healthy.

**Reward Rate Pool Contract**
 - Address: [0x11f040E89dFAbBA9070FFE6145E914AC68DbFea0](https://arbiscan.io/address/0x11f040E89dFAbBA9070FFE6145E914AC68DbFea0)
 - Proxy Admin Contract: [0x545B18EcD3D1b14b6B4fF2d4B9b8583714a036F8](https://arbiscan.io/address/0x545B18EcD3D1b14b6B4fF2d4B9b8583714a036F8)

The rewards pool contract is where new $SESH tokens for rewarding stakers are to
be transferred to. The token balance of this contract gets released to the
Service Node Rewards Contract at an approximate rate of 14% per annum. The
emission of tokens into the Service Node Rewards contract can be triggered by
any arbitrary wallet by calling `payoutRelease()` on the contract.

The $SESH rewards pool is kept separate from the rewards contract to minimise
the risk profile of token management due to the complexity of the
implementation of the Service Node Rewards contract.

**Multi Contributor Factory Contract**
 - Address: [0x8129bE2D5eF7ACd39483C19F28DE86b7EF19DBCA](https://arbiscan.io/address/0x8129bE2D5eF7ACd39483C19F28DE86b7EF19DBCA)
 - Proxy Admin Contract: [0xbAABf94FF34291C98C4eBCe2B599cf0D78F65125](https://arbiscan.io/address/0xbAABf94FF34291C98C4eBCe2B599cf0D78F65125)

This contract facilitates the ability to construct a Session node that accepts
multiple stakers to pool funds together for deploying a Session node in
a trustless manner. The factory spawns contracts that take ownership of the
pooled funds and provides access-control for contributors to enter and exit the
pool without requiring trust in the operator.

Pooled funds get combined into a single stake once the collateralisation
requirement is met and added into the Service Node Rewards contract to receive
funds. Any contributor can initiate the process of getting the node they
contributed to, to exit the network.

**L2 SESH Contract**
 - Address: [0x10Ea9E5303670331Bdddfa66A4cEA47dae4fcF3b](https://arbiscan.io/address/0x10Ea9E5303670331Bdddfa66A4cEA47dae4fcF3b)
 - Proxy Admin Contract: [0xCD289D931F6B8Ad8Ff1b6d95a64ade4DA60b68f1](https://arbiscan.io/address/0xCD289D931F6B8Ad8Ff1b6d95a64ade4DA60b68f1)

The $SESH token is deployed simultaneously on the Arbitrum and Ethereum contract
with a fixed supply. This contract is a derivative of Arbitrum's default bridged
token contract where transferring between Ethereum and Arbitrum ensures that the
token supply is burnt and minted appropriately when transferred cross-chain.

## Manual Contract Interaction

The recommended way to interact with contracts without relying on the staking
portal is to go to Arbiscan's address page for the desired contract and
navigating to `Contract > Write As Proxy` and connecting the wallet in question
to use on the contract.


**Registering a node onto the Session network**

To add a node to the Session network assuming you have the required $SESH tokens
(determinable by calling
[stakingRequirement()](https://arbiscan.io/address/0xC2B9fC251aC068763EbDfdecc792E3352E351c00#readProxyContract#F40)
on the contract) and have synced an `oxen-core` node to the tip of the chain and
the node is running in `--service-node` mode. On the machine with the
`oxen-core` node software installed and synced, run from the terminal the
command (replace `<Your Arbitrum address with the $SESH tokens>` with your
funded Arbitrum address):

```
oxend register 0x<Your Arbitrum address with the $SESH tokens> contract
```

This gets the node to create a signature that can be used to register the node
on the contract, e.g.:

```
L2 Contract Registration Information for 9e98e44c44683e87222a25adfa3490b076ab5b2ca92a74ed69890aa03f5b084e:
Operator address: 0xB538Ab4da8a26EEa48Ce9Db7971b5E4C60A0AcEd
ServiceNodeRewards.addBLSPublicKey()/multi-contract.reset...() parameters:
   blsPubkey/key=(0x2e7c17720791b5f60beabd82181553fc8f2c33e3a14b648b7e4509c28d194cd9, 0x22952a6552f5edb46c02d9d8a0c10f6b2394c91f45339a21f3d6feccf151afdf)
   blsSignature/sig=(0x1c3dbc4606cac51e72dd46a8a09c36d5947180941209054e9105245862a794a8, 0x0c01b11ab51c82d944b27e5208cd2ef769c4ccb991c9cd66ca2331ab005c2f57, 0x23808bdaaf7e7a683abceaac5d4014adfe1e0e82dd883b48b00f1b79bc2e3863, 0x1d3995c6ab7909d81776425fb52899fa3c29d2a8b2c07d8321326519f6fe553a)
   serviceNodeParams/params=(0x9e98e44c44683e87222a25adfa3490b076ab5b2ca92a74ed69890aa03f5b084e, 0x221d42b5226d2f83825e757376a7df818c97ba04708c6a81da7bccfe5fc8f5ff, 0x3a88f9c6b64618558d0f1b8c548f278fa57e0c27a74eadd3742519fa562bd403, 0)
```

The fields from the response here can be input into
[addBLSPublicKey()](https://arbiscan.io/address/0xC2B9fC251aC068763EbDfdecc792E3352E351c00#writeProxyContract#F2)
by using the following fields for each section

```
blsPubkey (tuple)
  X: <blsPubkey/key[0]>
  Y: <blsPubkey/key[1]>
blsSignature (tuple)
  sigs0: <blsSignature/sig[0]>
  sigs1: <blsSignature/sig[1]>
  sigs2: <blsSignature/sig[2]>
  sigs3: <blsSignature/sig[3]>
serviceNodeParams (tuple)
  serviceNodePubkey:     <serviceNodeParams/params[0]>
  serviceNodeSignature1: <serviceNodeParams/params[1]>
  serviceNodeSignature2: <serviceNodeParams/params[2]>
  fee: 0 (keep 0 for solo nodes)
contributors (tuple[])
  tuple: (keep empty for solo nodes)
```

For example, substituting in the values from the given example response is as
follows:

```
blsPubkey (tuple)
  X: 0x2e7c17720791b5f60beabd82181553fc8f2c33e3a14b648b7e4509c28d194cd9
  Y: 0x22952a6552f5edb46c02d9d8a0c10f6b2394c91f45339a21f3d6feccf151afdf
blsSignature (tuple)
   sigs0: 0x1c3dbc4606cac51e72dd46a8a09c36d5947180941209054e9105245862a794a8
   sigs1: 0x0c01b11ab51c82d944b27e5208cd2ef769c4ccb991c9cd66ca2331ab005c2f57
   sigs2: 0x23808bdaaf7e7a683abceaac5d4014adfe1e0e82dd883b48b00f1b79bc2e3863
   sigs3: 0x1d3995c6ab7909d81776425fb52899fa3c29d2a8b2c07d8321326519f6fe553a
serviceNodeParams (tuple)
  serviceNodePubkey:     0x9e98e44c44683e87222a25adfa3490b076ab5b2ca92a74ed69890aa03f5b084e
  serviceNodeSignature1: 0x221d42b5226d2f83825e757376a7df818c97ba04708c6a81da7bccfe5fc8f5ff
  serviceNodeSignature2: 0x3a88f9c6b64618558d0f1b8c548f278fa57e0c27a74eadd3742519fa562bd403
  fee: 0
contributors (tuple[])
  tuple:
```

**Claiming rewards for an address staking into the Session Network**

1. Retrieve a signature from the network that authorises the contract to update
the rewards due for your address to the latest amount that it's entitled to.
(Replace `0x<YOUR_ADDRESS>` with the Arbitrum address you staked from).
```bash
curl -X POST https://seed1.getsession.org/json_rpc -H "Content-Type: application/json" -d '{
    "jsonrpc": "2.0", "id": "0", "method": "bls_rewards_request",
    "params": { "address": "0x<YOUR_ADDRESS>" }
  }'
```

This produces a response like the following if it was successful:

```json
{
  "id": "0",
  "jsonrpc": "2.0",
  "result": {
    "address": "0x0123456789abcdef0123456789abcdef01234567",
    "aggregate_pubkey": "0dc2c6092a89cc6c8c210e267654c6cfa269902ecae204c64ba3ac3e183d30490f2a1e165221aaf27d6a00a4c66a62dd4e1a40103b20cbb35c6afdc4b955f57e",
    "amount": 102434883718711,
    "height": 2000000,
    "msg_to_sign": "8ef21a6f151a224f0b101c51e6e587b27d26c1f4c16e72874221f0102fa68ae73ac81340eb9bcf107238789524050fb77707088f00000000000000000000000000000000000000000000000000005d29fadb4e37",
    "non_signer_indices": [ 44, 54, 75 ],
    "signature": "04d063c94c870977041ed400d08de19fe8359709a00e4414c9b2ae85da4378ff098027ec1ab7b7371b6fa63ae0c5153bc8413b1bebc275bc0cbeca44544d0a82108adc3220ee609551296342aaa73b795b35cc69213b8358197118dd91528e1813597c3ccce88a4b6706a9dca925b7b0b95d4dc3a1de729a3aff75f526e30b50",
    "status": "OK"
  }
}
```

2. Update your rewards balance entitlement on the smart contract by inputting
the values from the response onto Arbiscan. Connect your Arbitrum wallet that is
staking to the network at
[updateRewardsBalance()](https://arbiscan.io/address/0xC2B9fC251aC068763EbDfdecc792E3352E351c00#writeProxyContract#F23).

At the URL, fill in the following form fields on the page for
`updateRewardsBalance()`, the following fields are to be populated using the
values received from the request above:

```
recipientAddress: <address>
recipientRewards: <amount>
blsSignature (tuple)
  sigs0:          signature[  0: 64)
  sigs1:          signature[ 64:128)
  sigs2:          signature[128:192)
  sigs3:          signature[192:256)
ids:              <non_signer_indices>
```

`sigs0`, `sigs1`, `sigs2` and `sigs3` require you to split up the signature into
4x32 byte chunks (i.e. 4 parts) which can be achieved as follows with
Python (using the example values from step 1. You would replace `sig_str
= <...>` with your `signature` value). You can reproduce this step using any
website online that allows you to execute Python if you do not have it installed
on your machine or split up the string yourself.

```python
sig_str = "04d063c94c870977041ed400d08de19fe8359709a00e4414c9b2ae85da4378ff098027ec1ab7b7371b6fa63ae0c5153bc8413b1bebc275bc0cbeca44544d0a82108adc3220ee609551296342aaa73b795b35cc69213b8358197118dd91528e1813597c3ccce88a4b6706a9dca925b7b0b95d4dc3a1de729a3aff75f526e30b50"
print("sigs0: " + sig_str[   : 64])
print("sigs1: " + sig_str[ 64:128])
print("sigs2: " + sig_str[128:192])
print("sigs3: " + sig_str[192:256])
```

Running this example outputs:

```
sigs0: 04d063c94c870977041ed400d08de19fe8359709a00e4414c9b2ae85da4378ff
sigs1: 098027ec1ab7b7371b6fa63ae0c5153bc8413b1bebc275bc0cbeca44544d0a82
sigs2: 108adc3220ee609551296342aaa73b795b35cc69213b8358197118dd91528e18
sigs3: 13597c3ccce88a4b6706a9dca925b7b0b95d4dc3a1de729a3aff75f526e30b50
```

Then fill in the form on Arbiscan for `updateRewardsBalance()`. For the `sigs`
0 to 3, ensure the string is prefixed with `0x` as shown in the following
example:

```
recipientAddress: 0x0123456789abcdef0123456789abcdef01234567
recipientRewards: 102434883718711
blsSignature (tuple)
  sigs0: 0x04d063c94c870977041ed400d08de19fe8359709a00e4414c9b2ae85da4378ff
  sigs1: 0x098027ec1ab7b7371b6fa63ae0c5153bc8413b1bebc275bc0cbeca44544d0a82
  sigs2: 0x108adc3220ee609551296342aaa73b795b35cc69213b8358197118dd91528e18
  sigs3: 0x13597c3ccce88a4b6706a9dca925b7b0b95d4dc3a1de729a3aff75f526e30b50
ids: 44,54,75
```

Press the write button to send the transaction to update your address's rewards balance.

3. Once the transaction has completed you can now claim your updated balance.
Simply go to the
[claimRewards()](https://arbiscan.io/address/0xC2B9fC251aC068763EbDfdecc792E3352E351c00#writeProxyContract#F4)
section and with staking wallet still connected press the `Write` button to
create a transaction that will claim the $SESH rewards balance from the contract
into your wallet.

**Emit $SESH rewards from the pool to the Service node contract**

1. Connect a wallet on Arbiscan at
[payoutRelease](https://arbiscan.io/address/0x11f040E89dFAbBA9070FFE6145E914AC68DbFea0#writeProxyContract#F3)
then press the `Write` button to release the tokens to the contract. This
function can be called by any wallet.

**Initiating exit for a Session Node**

Node operators can manually initiate the exit process for their Session node
directly via Arbiscan.

The Session network identifies nodes by their ED25519 public key, but the smart
contract uses a numeric `serviceNodeID`. First, retrieve your ED25519 public key
from your Session node (`oxend status`) then:

1. Go to
[ed25519ToServiceNodeID()](https://arbiscan.io/address/0xC2B9fC251aC068763EbDfdecc792E3352E351c00#readProxyContract#F17)

2. Enter your Session Node's ED25519 public key in its `0x...` format and click
"Query" to retrieve your `serviceNodeID`. The result will be a number (e.g., 13).
If the result is 0, the ED25519 public key is not registered in the contract.

Once you have your `serviceNodeID`, you can initiate the exit process.

3. Go to
[initiateExitBLSPublicKey()](https://arbiscan.io/address/0xC2B9fC251aC068763EbDfdecc792E3352E351c00#writeProxyContract#F8)
and ensure your wallet is connected. The wallet must be the operator of the
service node, OR a contributor who has staked into the node. Fill the form
field:

```
serviceNodeID: <the number retrieved from Step 1>
```

4. Click "Write" to send the transaction. Confirm the transaction in your
wallet. What happens next:
- The transaction emits an event that is witnessed by the Session network
- The exit process begins and a wait period starts
- After the mandatory wait time (15 days for small contributors, immediate for
  operators), you or any contributor can call `exitBLSPublicKeyAfterWaitTime()`
  to complete the exit and retrieve your staked funds
- During the wait period, the node will stop receiving new rewards. If you
  are a small contributor (contributing less than 25% of the total stake), you
  must wait 15 days after initiating exit before the stake can be withdrawn.
  Operators and large contributors can exit immediately after initiation.

**Completing Exit for a Session Node (With Network Signature)**

After initiating an exit and awaiting the 15 day period you may proceed with
formally exiting from the network as follows.

1. Request an exit signature from the network using your ED25519 public key:

```bash
curl -X POST https://seed1.getsession.org/json_rpc -H "Content-Type: application/json" -d '{
    "jsonrpc": "2.0",
    "id": "0",
    "method": "bls_exit_liquidation_request",
    "params": {
      "pubkey": "0x<YOUR SESSION NODE ED25519 PUBKEY>",
      "liquidate": false
    }
  }'
```

This produces a response like the following if successful:

```json
{
  "id": "0",
  "jsonrpc": "2.0",
  "result": {
    "bls_pubkey": "0dc2c6092a89cc6c8c210e267654c6cfa269902ecae204c64ba3ac3e183d30490f2a1e165221aaf27d6a00a4c66a62dd4e1a40103b20cbb35c6afdc4b955f57e",
    "signature": "04d063c94c870977041ed400d08de19fe8359709a00e4414c9b2ae85da4378ff098027ec1ab7b7371b6fa63ae0c5153bc8413b1bebc275bc0cbeca44544d0a82108adc3220ee609551296342aaa73b795b35cc69213b8358197118dd91528e1813597c3ccce88a4b6706a9dca925b7b0b95d4dc3a1de729a3aff75f526e30b50",
    "timestamp": 1775089648,
    "non_signer_indices": [ 44, 54, 75 ],
    "status": "OK"
  }
}
```

2. Convert the signature and BLS pubkey into the format required by the
contract. The `signature` field needs to be split into 4x32 byte chunks
(`sigs0`, `sigs1`, `sigs2`, `sigs3`), similar to claiming rewards. The BLS
pubkey needs to be split into 2x32 byte chunks.

```python
bls_pubkey = "0dc2c6092a89cc6c8c210e267654c6cfa269902ecae204c64ba3ac3e183d30490f2a1e165221aaf27d6a00a4c66a62dd4e1a40103b20cbb35c6afdc4b955f57e"
print("X: " + bls_pubkey[   :64])
print("Y: " + bls_pubkey[64:128])

sig_str = "04d063c94c870977041ed400d08de19fe8359709a00e4414c9b2ae85da4378ff098027ec1ab7b7371b6fa63ae0c5153bc8413b1bebc275bc0cbeca44544d0a82108adc3220ee609551296342aaa73b795b35cc69213b8358197118dd91528e1813597c3ccce88a4b6706a9dca925b7b0b95d4dc3a1de729a3aff75f526e30b50"
print("sigs0: " + sig_str[   : 64])
print("sigs1: " + sig_str[ 64:128])
print("sigs2: " + sig_str[128:192])
print("sigs3: " + sig_str[192:256])
```

Running this outputs:

```
X: 0dc2c6092a89cc6c8c210e267654c6cfa269902ecae204c64ba3ac3e183d3049
Y: 0f2a1e165221aaf27d6a00a4c66a62dd4e1a40103b20cbb35c6afdc4b955f57e
sigs0: 04d063c94c870977041ed400d08de19fe8359709a00e4414c9b2ae85da4378ff
sigs1: 098027ec1ab7b7371b6fa63ae0c5153bc8413b1bebc275bc0cbeca44544d0a82
sigs2: 108adc3220ee609551296342aaa73b795b35cc69213b8358197118dd91528e18
sigs3: 13597c3ccce88a4b6706a9dca925b7b0b95d4dc3a1de729a3aff75f526e30b50
```

3. Go to
[exitBLSPublicKeyWithSignature()](https://arbiscan.io/address/0xC2B9fC251aC068763EbDfdecc792E3352E351c00#writeProxyContract#F6)
and connect your wallet. Any wallet can be used to exit since the signature is
sufficient for network consensus and fill in the form fields using the values
from the request as follows (ensuring that `X`, `Y` and `sigs` 0 to 3 are
prefixed with `0x`).

```
blsPubkey (tuple):
  X:                <X>
  Y:                <Y>
timestamp:          <timestamp>
blsSignature (tuple):
  sigs0:            signature[  0: 64)
  sigs1:            signature[ 64:128)
  sigs2:            signature[128:192)
  sigs3:            signature[192:256)
ids:                <non_signed_indices>
```

For example, given the previous values we generated this is an example of
filling in the form with those values (note that `X`, `Y` and `sigs` 0 to 3 are
prefixed with `0x`).

```
blsPubkey (tuple):
  X: 0x0dc2c6092a89cc6c8c210e267654c6cfa269902ecae204c64ba3ac3e183d3049
  Y: 0x0f2a1e165221aaf27d6a00a4c66a62dd4e1a40103b20cbb35c6afdc4b955f57e
timestamp: 1775089648
blsSignature (tuple):
  sigs0: 0x04d063c94c870977041ed400d08de19fe8359709a00e4414c9b2ae85da4378ff
  sigs1: 0x098027ec1ab7b7371b6fa63ae0c5153bc8413b1bebc275bc0cbeca44544d0a82
  sigs2: 0x108adc3220ee609551296342aaa73b795b35cc69213b8358197118dd91528e18
  sigs3: 0x13597c3ccce88a4b6706a9dca925b7b0b95d4dc3a1de729a3aff75f526e30b50
ids: 44,54,75
```

4. Click "Write" to send the transaction. Once confirmed, your stake will be
returned to your wallet and the node will be removed from the network.

**Liquidating a Session Node**

A node that has initiated an exit but has not exited the network within 7 days
from the time they are eligible to exit can be liquidated from the network and
be rewarded a portion of the $SESH from the stake of the node. Doing this is the
same as following the steps for **Completing Exit for a Session Node** but
ensuring that `liquidate` is set to `true` instead of `false` in step 1.

**Exiting Session Node after an extended period of time of eligibility**

In the event that an exit for a Session Node has been requested and the 15 days
have transpired if a node has not been forcibly liquidated within 30 days after
the leave request was submitted it is possible as a fallback to remove a node
from the Session node list via the contract by calling
[exitBLSPublicKeyAfterWaitTime()](https://arbiscan.io/address/0xC2B9fC251aC068763EbDfdecc792E3352E351c00#writeProxyContract#F5).

This function requires you to convert your Session Node's ED25519 to an ID which
is detailed in step 1 of **Initiating exit for a Session Node**.
