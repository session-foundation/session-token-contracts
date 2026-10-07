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
# Alternatively, use `--trezor` to sign transactions with a Trezor hardware wallet (requires the
# `trezor` Python package).  Each transaction must then be confirmed on the device, so this is mainly
# useful in combination with `--once` and/or `--pubkeys`.
#
# It runs continuously, and requires access to an L2 provider and an oxend node (which itself must
# also have an L2 provider).  Although it can run using a service node's RPC address, using a
# service node is not required.
#
# Run with `--help` as an argument for more info.

from web3 import Web3, middleware, exceptions as w3ex
import requests
from eth_account import Account
from eth_account.typed_transactions import TypedTransaction
from solcx import compile_source, install_solc
import argparse
import sys
import os
import re
from Crypto.Hash import keccak
import time


parser = argparse.ArgumentParser(
    prog="liquidator", description="Auto-liquidator of deregged/expired Session nodes"
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
    "the ETH_PRIVATE_KEY=0x... environment variable, unless using --trezor",
)
parser.add_argument(
    "-T",
    "--trezor",
    nargs="?",
    const="m/44'/60'/0'/0/0",
    metavar="BIP32_PATH",
    help="Sign transactions using a connected Trezor hardware wallet instead of ETH_PRIVATE_KEY.  "
    "Optionally takes the derivation path of the account to use (default: m/44'/60'/0'/0/0).  "
    "If multiple Trezors are connected, set TREZOR_PATH to select one.",
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
    "-1",
    "--once",
    action="store_true",
    help="Run one iteration and then exit, rather than sleeping and repeating indefinitely",
)
parser.add_argument(
    "-E",
    "--exit",
    action="store_true",
    help="Submit exits (earning no reward) instead of liquidations (with reward)",
)
parser.add_argument(
    "-P",
    "--pubkeys",
    type=str,
    help="Only liquidate/exit nodes that have an Oxen or BLS pubkey in the given list (whitespace or comma delimited)",
)
parser.add_argument(
    "-n",
    "--dry-run",
    action="store_true",
    help="Print liquidations instead of actually submitting them",
)

args = parser.parse_args()

account = None
trezor_session = None
if args.trezor:
    from trezorlib import ethereum as trezor_eth
    from trezorlib.cli import get_code_entry_code
    from trezorlib.cli.ui import ClickUI
    from trezorlib.client import get_default_client, get_default_session
    from trezorlib.tools import parse_path
    from trezorlib.transport import get_transport

    try:
        trezor_path = parse_path(args.trezor)
    except ValueError as e:
        print(f"Invalid --trezor derivation path '{args.trezor}': {e}", file=sys.stderr)
        sys.exit(1)

    try:
        transport = get_transport(os.getenv("TREZOR_PATH"), prefix_search=True)
        transport.open()
        trezor_ui = ClickUI()
        trezor_client = get_default_client(
            "session-liquidator",
            transport,
            button_callback=trezor_ui.button_request,
            pin_callback=trezor_ui.get_pin,
            code_entry_callback=get_code_entry_code,
        )
        trezor_session = get_default_session(trezor_client)
        address = trezor_eth.get_address(trezor_session, trezor_path)
    except Exception as e:
        print(f"Failed to connect to Trezor: {e}", file=sys.stderr)
        sys.exit(1)
    key_source = f"Trezor path {args.trezor}"
else:
    private_key = os.environ.get("ETH_PRIVATE_KEY")
    if args.dry_run and not private_key:
        account = Account.create()
        print(
            "ETH_PRIVATE_KEY is not set, but --dry-run is used so generating a random one:",
            file=sys.stderr,
        )
        print(f"    privkey={Web3.to_hex(account.key)}", file=sys.stderr)
    else:
        if not private_key:
            print("ETH_PRIVATE_KEY is not set (and --trezor not given)!", file=sys.stderr)
            sys.exit(1)
        if not private_key.startswith("0x") or len(private_key) != 66:
            print("ETH_PRIVATE_KEY is set but looks invalid", file=sys.stderr)
            sys.exit(1)
        account = Account.from_key(private_key)
    address = account.address
    key_source = "ETH_PRIVATE_KEY"

if args.wallet and args.wallet != address:
    print(
        f"{key_source} yielded wallet address {address} which doesn't match --wallet {args.wallet}",
        file=sys.stderr,
    )
    sys.exit(1)


def verbose(*a, **kw):
    if args.verbose:
        print(*a, **kw)


filter_pks = set()
if args.pubkeys:
    for pk in re.split(r"[\s,]+", args.pubkeys):
        if not pk:
            continue
        if len(pk) not in (64, 128) or not all(
            c in "0123456789ABCDEFabcdef" for c in pk
        ):
            print(f"Invalid pubkey '{pk}' given to --pubkeys", file=sys.stderr)
            sys.exit(1)
        filter_pks.add(pk)
    if not filter_pks:
        print(f"Error: No pubkeys provided to --pubkeys/-P option")
        sys.exit(1)
    verbose(f"Filtering on {len(filter_pks)} pubkeys")


print(f"Using wallet {address}")

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


print(f"Loading contracts...")
basedir = os.path.dirname(__file__) + "/.."
install_solc("0.8.30")
compiled_sol = compile_source(
    """
import "SESH.sol";
import "ServiceNodeRewards.sol";
""",
    base_path=basedir,
    include_path=f"{basedir}/contracts",
    solc_version="0.8.30",
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


expect_chain = 0xA4B1 if args.mainnet else 0x66EEE
actual_chain = w3.eth.chain_id
if actual_chain != expect_chain:
    print(
        f"L2 provider is for the wrong chain for {netname}: expected 0x{expect_chain:x}, L2 provider is 0x{actual_chain:x}",
        file=sys.stderr,
    )
    sys.exit(1)

if account:
    w3.middleware_onion.add(middleware.SignAndSendRawMiddlewareBuilder.build(account))

w3.eth.default_account = address


def send_tx(tx):
    if not trezor_session:
        return tx.transact()

    params = tx.build_transaction(
        {"from": address, "nonce": w3.eth.get_transaction_count(address, "pending")}
    )
    print(
        f"\n    Confirm the transaction on your Trezor (to: {params['to']})...",
        end="",
        flush=True,
    )
    v, r, s = trezor_eth.sign_tx_eip1559(
        trezor_session,
        trezor_path,
        nonce=params["nonce"],
        gas_limit=params["gas"],
        to=params["to"],
        value=params["value"],
        data=Web3.to_bytes(hexstr=params["data"]),
        chain_id=params["chainId"],
        max_gas_fee=params["maxFeePerGas"],
        max_priority_fee=params["maxPriorityFeePerGas"],
    )
    del params["from"]
    signed = TypedTransaction.from_dict(
        {
            **params,
            "type": 2,
            "accessList": [],
            "v": v,
            "r": int.from_bytes(r),
            "s": int.from_bytes(s),
        }
    )
    return w3.eth.send_raw_transaction(signed.encode())


def tx_url(txid):
    return f"https://{'' if args.mainnet else 'sepolia.'}arbiscan.io/tx/0x{txid}"


def get_contract(name, addr):
    return w3.eth.contract(address=addr, abi=compiled_sol[name]["abi"])


if args.mainnet:
    print("Configured for SESH mainnet")
    sesh_addr, snrewards_addr = (
        "0x10Ea9E5303670331Bdddfa66A4cEA47dae4fcF3b",
        "0xC2B9fC251aC068763EbDfdecc792E3352E351c00",
    )
elif args.devnet:
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
    sesh_addr, snrewards_addr = (
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
ignore = set()
liquidation_attempts = 0
s_liquidatable = "exitable" if args.exit else "liquidatable"
s_Liquidating = "Exiting" if args.exit else "Liquidating"
s_liquidation = "exit" if args.exit else "liquidation"
s_liquidate = "exit" if args.exit else "liquidate"
while True:
    verbose(f"Checking for {s_liquidatable} nodes...")

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
        verbose(f"{len(r)} potentially {s_liquidatable} nodes")

        # FIXME - hack around bug of being in both active and recently removed:
        rsns = requests.post(
                oxen_rpc,
                json={"jsonrpc": "2.0", "id": 0, "method": "get_service_nodes",
                      "params": {"fields": ["service_node_pubkey"]}})
        rsns.raise_for_status()
        active_sns = set(x["service_node_pubkey"] for x in rsns.json()["result"]["service_node_states"])

        for sn in r:
            pk = sn["service_node_pubkey"]
            bls = sn["info"]["pubkey_bls"]
            if pk in active_sns:
                print(f"Error: not exiting {pk} because it's both active and recently removed")
                ignore.add(pk)
            if pk in ignore:
                continue
            if filter_pks and not (pk in filter_pks or bls in filter_pks):
                verbose(f"Given pubkey filter does not include {pk}")
                ignore.add(pk)
                continue
            if bls not in contract_nodes:
                verbose(
                    f"{pk} (BLS: {bls}) is not in the contract (perhaps liquidation/exit already in progress?)"
                )
                ignore.add(pk)
                continue
            if args.exit or sn["liquidation_height"] <= height:
                verbose(f"{pk} is {s_liquidatable}!")
                liquidate.append(sn)
            else:
                n_blocks = sn["liquidation_height"] - height
                duration = (
                    "{}d{:.0f}h".format(n_blocks // 720, (n_blocks % 720) / 30)
                    if n_blocks >= 720
                    else "{}h{}m".format(n_blocks // 30, (n_blocks % 30) * 2)
                )
                verbose(
                    f"{pk} not liquidatable until: {sn['liquidation_height']}, in {n_blocks} blocks (~{duration})"
                )

    except Exception as e:
        print(f"oxend liquidation list request failed: {e}", file=sys.stderr)
        continue

    if liquidate:
        print(f"{s_Liquidating} {len(liquidate)} eligible service nodes")
    for sn in liquidate:
        try:
            pk = sn["service_node_pubkey"]
            info = sn["info"]
            print(f"\n{s_Liquidating} SN {pk}\n    BLS: {info['pubkey_bls']}")

            r = requests.post(
                oxen_rpc,
                json={
                    "jsonrpc": "2.0",
                    "id": 0,
                    "method": "bls_exit_liquidation_request",
                    "params": {"pubkey": pk, "liquidate": not args.exit},
                },
                timeout=20,
            )
            r.raise_for_status()
            r = r.json()

            if "error" in r:
                print(
                    f"Failed to obtain {s_liquidation} signature for {pk}: {r['error']['message']}"
                )
                continue

            print(f"    Obtained service node network {s_liquidation} signature")

            r = r["result"]
            bls_pk = r["bls_pubkey"]
            bls_pk = (int(bls_pk[0:64], 16), int(bls_pk[64:128], 16))
            bls_sig = r["signature"]
            bls_sig = tuple(int(bls_sig[i : i + 64], 16) for i in (0, 64, 128, 192))

            meth = (
                ServiceNodeRewards.exitBLSPublicKeyWithSignature
                if args.exit
                else ServiceNodeRewards.liquidateBLSPublicKeyWithSignature
            )
            tx = meth(bls_pk, r["timestamp"], bls_sig, r["non_signer_indices"])
            fn_details = f"ServiceNodeRewards (={ServiceNodeRewards.address}) function {tx.fn_name} (={tx.selector}) with args:\n{tx.arguments}"
            if args.dry_run:
                print(f"    \x1b[32;1mDRY-RUN: would have invoked {fn_details}\x1b[0m")
            else:
                verbose(f"    About to invoke: {fn_details}")
                print(f"    Submitting {s_liquidation} tx...", end="", flush=True)
                txid = send_tx(tx)
                print(
                    f"\x1b[32;1m done! txid: \x1b]8;;{tx_url(txid.hex())}\x1b\\{txid.hex()}\x1b]8;;\x1b\\\x1b[0m"
                )

            ignore.add(pk)

        except w3ex.ContractCustomError as e:
            err = lookup_error(e.data[2:10])
            if err:
                print(
                    f"\n\x1b[31;1mFailed to {s_liquidate} SN {pk}:\nContract error {err} with data:\n    {e.data[10:]}\x1b[0m"
                )
            else:
                print(
                    f"\n\x1b[31;1mFailed to {s_liquidate} SN {pk}:\nUnknown contract error:\n    {e.data}\x1b[0m"
                )
        except Exception as e:
            print(f"\n\x1b[31;1mFailed to {s_liquidate} SN {pk}: {e}\x1b[0m")

        liquidation_attempts += 1
        if args.max_liquidations and liquidation_attempts >= args.max_liquidations:
            print(
                f"Reached --max-liquidations ({args.max_liquidations}) {s_liquidation} attempts; exiting"
            )
            sys.exit(0)

    if args.once:
        verbose(f"Done!")
        break

    verbose(f"Done loop; sleeping for {args.sleep}")
    time.sleep(args.sleep)
