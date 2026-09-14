// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script, console2} from "forge-std/Script.sol";
import {SpacaEscrow} from "../src/SpacaEscrow.sol";

/**
 * Deploys SpacaEscrow and allowlists one token.
 *
 *   ESCROW_OWNER, ESCROW_RELEASE_SIGNER, ESCROW_GUARDIAN, ESCROW_TOKEN, ESCROW_RECLAIM_DELAY_SECONDS (optional)
 *   forge script script/Deploy.s.sol --rpc-url arc_testnet --broadcast --private-key <deployer key from a secret store>
 *
 * On Arc testnet ESCROW_TOKEN is the USDC ERC-20 interface 0x3600000000000000000000000000000000000000 (6 decimals).
 * The deployer becomes owner only for the allowlist call, then ownership moves to ESCROW_OWNER in two steps; the
 * new owner must call acceptOwnership().
 */
contract Deploy is Script {
    function run() external returns (SpacaEscrow escrow) {
        address finalOwner = vm.envAddress("ESCROW_OWNER");
        address signer = vm.envAddress("ESCROW_RELEASE_SIGNER");
        address guardian = vm.envAddress("ESCROW_GUARDIAN");
        address token = vm.envAddress("ESCROW_TOKEN");
        uint64 delay = uint64(vm.envOr("ESCROW_RECLAIM_DELAY_SECONDS", uint256(60 days)));

        vm.startBroadcast();
        escrow = new SpacaEscrow(msg.sender, signer, guardian, delay);
        escrow.setTokenAllowed(token, true);
        if (finalOwner != msg.sender) escrow.transferOwnership(finalOwner);
        vm.stopBroadcast();

        console2.log("SpacaEscrow", address(escrow));
        console2.log("chainId", block.chainid);
        console2.log("token", token);
        console2.log("pendingOwner", escrow.pendingOwner());
    }
}
