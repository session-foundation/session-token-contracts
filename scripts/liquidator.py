#!/usr/bin/python3

# Session Token network auto-liquidation script.  This script scans the network for liquidatable
# nodes and submits liquidation requests for any liquidatable nodes to remove them from the Service
# Node contract, rewarding the wallet holder and the possibly rewards pool (see the contract for
# specific ratios) with a small penalty taken from the node's staked SESH, deducted from the
# operator's returned stake.
#
# To run it, you need various Python dependencies (easily installed via pip or system dependencies),
# and you need to set up a wallet with ARB-ETH funds to submit the transactions; this wallet then
# receives the SESH in return for the liquidation.  Run with ETH_PRIVATE_KEY set in the enviroment
# to an ethereum private key (for example, one generated with Metamask) for the script to use for
# network interactions.
#
# It runs continuously, and requires access to an L2 provider and an oxend node (which itself must
# also have an L2 provider).  Although it can run using a service node's RPC address, using a
# service node is not required.
#
# Run with `--help` as an argument for more info.

from web3 import Web3, middleware, exceptions as w3ex
import requests
from eth_account import Account
from solcx import compile_source, install_solc
import argparse
import sys
import os
from Crypto.Hash import keccak
import time


parser = argparse.ArgumentParser(
    prog="liquidator", description="Auto-liquidator of deregged/expires Session nodes"
)

netparser = parser.add_mutually_exclusive_group(required=True)
netparser.add_argument(
    "--stagenet", action="store_true", help="Run for the stagenet network"
)
netparser.add_argument(
    "--devnet", action="store_true", help="Run for the devnet network"
)
netparser.add_argument(
    "--testnet", action="store_true", help="Run for the testnet network"
)
netparser.add_argument(
    "--mainnet", action="store_true", help="Run for the main Session network"
)


parser.add_argument("-l", "--l2", help="L2 provider URL", required=True)
parser.add_argument("-o", "--oxen", help="Oxen node RPC URL", required=True)
parser.add_argument(
    "-w",
    "--wallet",
    help="Eth wallet address to verify; the private key must be specified via "
    "the ETH_PRIVATE_KEY=0x... environment variable",
)
parser.add_argument(
    "-v", "--verbose", action="store_true", help="Make your terminal work harder"
)
parser.add_argument(
    "-s", "--sleep", default=30, type=int, help="Sleep time between liquidation checks"
)
parser.add_argument(
    "-m", "--max-liquidations", type=int, help="Stop after liquidating this many SNs"
)
parser.add_argument(
    "-n",
    "--dry-run",
    action="store_true",
    help="Print liquidations instead of actually submitting them",
)

args = parser.parse_args()

private_key = os.environ.get("ETH_PRIVATE_KEY")
if not private_key:
    print("ETH_PRIVATE_KEY is not set!", file=sys.stderr)
    sys.exit(1)
if not private_key.startswith("0x") or len(private_key) != 66:
    print("ETH_PRIVATE_KEY is set but looks invalid", file=sys.stderr)
    sys.exit(1)

account = Account.from_key(private_key)

if args.wallet and args.wallet != account.address:
    print(
        f"ETH_PRIVATE_KEY yielded wallet address {account.address} which doesn't match --wallet {args.wallet}",
        file=sys.stderr,
    )
    sys.exit(1)

print(f"Using wallet {account.address}")

print(f"Loading contracts...")
basedir = os.path.dirname(__file__) + "/.."
install_solc("0.8.26")
compiled_sol = compile_source(
    """
import "SESH.sol";
import "ServiceNodeRewards.sol";
""",
    base_path=basedir,
    include_path=f"{basedir}/contracts",
    solc_version="0.8.26",
    revert_strings="debug",
    import_remappings={
        "@openzeppelin/contracts": "node_modules/@openzeppelin/contracts",
        "@openzeppelin/contracts-upgradeable": "node_modules/@openzeppelin/contracts-upgradeable",
    },
)

w3 = Web3(Web3.HTTPProvider(args.l2))
if not w3.is_connected():
    print("L2 connection failed; check your --l2 value", file=sys.stderr)
    sys.exit(1)

netname = (
    "mainnet"
    if args.mainnet
    else (
        "testnet"
        if args.testnet
        else "devnet" if args.devnet else "stagenet" if args.stagenet else "???"
    )
)

oxen_rpc = args.oxen + "/json_rpc"
r = requests.post(oxen_rpc, json={"jsonrpc": "2.0", "id": 0, "method": "get_info"})
oxen_net = r.json()["result"]["nettype"]
if oxen_net != netname:
    print(
        f"Oxen RPC (--oxen) looks like the wrong network: '{oxen_net}', expected '{netname}'",
        file=sys.stderr,
    )
    sys.exit(1)


expect_chain = 0xA4B1 if args.mainnet else 0x66EEE
actual_chain = w3.eth.chain_id
if actual_chain != expect_chain:
    print(
        f"L2 provider is for the wrong chain for {netname}: expected 0x{expect_chain:x}, L2 provider is 0x{actual_chain:x}",
        file=sys.stderr,
    )
    sys.exit(1)

w3.middleware_onion.add(middleware.SignAndSendRawMiddlewareBuilder.build(account))

w3.eth.default_account = account.address


def tx_url(txid):
    return f"https://{'' if args.mainnet else 'sepolia.'}arbiscan.io/tx/0x{txid}"


def get_contract(name, addr):
    return w3.eth.contract(address=addr, abi=compiled_sol[name]["abi"])


if args.devnet:
    print("Configured for Oxen devnet(v3)")
    sesh_addr, snrewards_addr = (
        "0x8CB4DC28d63868eCF7Da6a31768a88dCF4465def",
        "0x75Dc11700b2D03902FCb5Ca7aFd6A859a1Fa25Cb",
    )
elif args.stagenet:
    print("Configured for Oxen stagenet")
    sesh_addr, snrewards_addr = (
        "0x7D7fD4E91834A96cD9Fb2369E7f4EB72383bbdEd",
        "0x9d8aB00880CBBdc2Dcd29C179779469A82E7be35",
    )
elif args.testnet:
    print("Configured for Oxen testnet")
    sent_addr, snrewards_addr = (
        "0xA5E28A879F464438Bb300903464382feA62828D0",
        "0x0B5C58A27A41D5fE3FF83d74060d761D7dDDc1D2",
    )
else:
    print(f"This script does not support Session {netname} yet!", file=sys.stderr)
    sys.exit(1)


SESH = get_contract("SESH.sol:SESH", sesh_addr).functions
ServiceNodeRewards = get_contract(
    "ServiceNodeRewards.sol:ServiceNodeRewards", snrewards_addr
).functions


def keccak4(x):
    k = keccak.new(digest_bits=256)
    k.update(x)
    return f"0x{k.hexdigest()[0:8]}"


def encode_call(c):
    return (
        c["name"].encode()
        + b"("
        + b",".join(i["type"].encode() for i in c["inputs"])
        + b")"
    )


def friendly_call(c):
    return (
        f'{c["type"]} {c["name"]}('
        + ", ".join(f"{i['internalType']} {i['name']}" for i in c["inputs"])
        + ")"
    )


errors = {
    keccak4(encode_call(x)): friendly_call(x)
    for x in ServiceNodeRewards.abi
    if x["type"] == "error"
}


def encode_bls_pubkey(bls_pubkey):
    off = 2 if bls_pubkey.startswith("0x") else 0
    assert len(bls_pubkey) == off + 128
    return tuple(int(bls_pubkey[off + i : off + i + 64], 16) for i in (0, 64))


def encode_bls_signature(bls_sig):
    off = 2 if bls_sig.startswith("0x") else 0
    assert len(bls_sig) == off + 256
    return tuple(int(bls_sig[off + i : off + i + 64], 16) for i in (0, 64, 128, 192))


def verbose(*a, **kw):
    if args.verbose:
        print(*a, **kw)


error_defs = {}
for n in compiled_sol["ServiceNodeRewards.sol:ServiceNodeRewards"]["ast"]["nodes"]:
    if (
        n.get("nodeType") == "ContractDefinition"
        and n.get("name") == "ServiceNodeRewards"
    ):
        for x in n["nodes"]:
            if x.get("nodeType") == "ErrorDefinition":
                error_defs[x["errorSelector"]] = x


def lookup_error(selector):
    e = error_defs.get(selector)
    return e["name"] if e else None


last_height = 0
liquidated = set()
liquidation_attempts = 0
while True:
    verbose("Checking for liquidatable nodes...")

    contract_nodes = set(
        f"{x[0]:064x}{x[1]:064x}"
        for x in ServiceNodeRewards.allServiceNodeIDs().call()[1]
    )

    liquidate = []
    try:
        height = requests.post(
            oxen_rpc, json={"jsonrpc": "2.0", "id": 0, "method": "get_height"}
        ).json()["result"]["height"]
        verbose(f"Current height: {height}")
        if height <= last_height:
            verbose(f"Height unchanged {height} since last request")
            continue
        r = requests.post(
            oxen_rpc,
            json={"jsonrpc": "2.0", "id": 0, "method": "bls_exit_liquidation_list"},
        )
        r.raise_for_status()
        r = r.json()["result"]
        verbose(f"{len(r)} potentially liquidatable nodes")

        for sn in r:
            pk = sn["service_node_pubkey"]
            bls = sn["info"]["bls_public_key"]
            if pk in liquidated:
                verbose(f"Already liquidated {pk}")
            elif bls not in contract_nodes:
                verbose(
                    f"{pk} (BLS: {bls}) is not in the contract (perhaps liquidation/removal already in progress?)"
                )
            elif sn["liquidation_height"] <= height:
                verbose(f"{pk} is liquidatable")
                liquidate.append(sn)
            else:
                verbose(
                    f"{pk} not liquidatable (liquidation height: {sn['liquidation_height']})"
                )

    except Exception as e:
        print(f"oxend liquidation list request failed: {e}", file=sys.stderr)
        continue

    for sn in liquidate:
        try:
            pk = sn["service_node_pubkey"]
            info = sn["info"]
            print(f"\nLiquidating SN {pk}\n    BLS: {info['bls_public_key']}")

            r = requests.post(
                oxen_rpc,
                json={
                    "jsonrpc": "2.0",
                    "id": 0,
                    "method": "bls_exit_liquidation_request",
                    "params": {"pubkey": pk, "liquidate": True},
                },
                timeout=20,
            )
            r.raise_for_status()
            r = r.json()

            if "error" in r:
                print(
                    f"Failed to obtain liquidation signature for {pk}: {r['error']['message']}"
                )
                continue

            print("    Obtained service node network liquidation signature")

            r = r["result"]
            bls_pk = r["bls_pubkey"]
            bls_pk = (int(bls_pk[0:64], 16), int(bls_pk[64:128], 16))
            bls_sig = r["signature"]
            bls_sig = tuple(int(bls_sig[i : i + 64], 16) for i in (0, 64, 128, 192))

            tx = ServiceNodeRewards.liquidateBLSPublicKeyWithSignature(
                bls_pk, r["timestamp"], bls_sig, r["non_signer_indices"]
            )
            fn_details = f"ServiceNodeRewards (={ServiceNodeRewards.address}) function {tx.fn_name} (={tx.selector}) with args:\n{tx.arguments}"
            if args.dry_run:
                print(f"    \x1b[32;1mDRY-RUN: would have invoked {fn_details}\x1b[0m")
            else:
                verbose(f"    About to invoke: {fn_details}")
                print("    Submitting liquidating tx...", end="", flush=True)
                txid = tx.transact()
                print(
                    f"\x1b[32;1m done! txid: \x1b]8;;{tx_url(txid.hex())}\x1b\\{txid.hex()}\x1b]8;;\x1b\\\x1b[0m"
                )

            liquidated.add(pk)

        except w3ex.ContractCustomError as e:
            err = lookup_error(e.data[2:10])
            if err:
                print(
                    f"\n\x1b[31;1mFailed to liquidate SN {pk}:\nContract error {err} with data:\n    {e.data[10:]}\x1b[0m"
                )
            else:
                print(
                    f"\n\x1b[31;1mFailed to liquidate SN {pk}:\nUnknown contract error:\n    {e.data}\x1b[0m"
                )
        except Exception as e:
            print(f"\n\x1b[31;1mFailed to liquidate SN {pk}: {e}\x1b[0m")

        liquidation_attempts += 1
        if args.max_liquidations and liquidation_attempts >= args.max_liquidations:
            print(
                f"Reached --max-liquidations ({args.max_liquidations}) liquidation attempts, exiting"
            )
            sys.exit(0)

    verbose(f"Done loop; sleeping for {args.sleep}")
    time.sleep(args.sleep)
