// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {SpacaEscrow} from "../src/SpacaEscrow.sol";
import {MockUSDC} from "./mocks/Tokens.sol";

/// @notice Drives random funding, releases, refunds, freezes, pauses and reclaims across a few buckets and payers.
contract EscrowHandler is Test {
    SpacaEscrow public escrow;
    MockUSDC public usdc;
    uint256 internal signerKey;
    address internal owner;
    address internal guardian;

    address[3] public payers;
    bytes32[4] public buckets;
    uint256 public ghostDeposited;
    uint256 public ghostPaidOut;
    uint256 internal counter;

    constructor(SpacaEscrow escrow_, MockUSDC usdc_, uint256 signerKey_, address owner_, address guardian_) {
        escrow = escrow_;
        usdc = usdc_;
        signerKey = signerKey_;
        owner = owner_;
        guardian = guardian_;
        for (uint256 i = 0; i < 3; i++) {
            payers[i] = makeAddr(string(abi.encode("payer", i)));
            usdc.mint(payers[i], 10_000_000e6);
            vm.prank(payers[i]);
            usdc.approve(address(escrow), type(uint256).max);
        }
        for (uint256 i = 0; i < 4; i++) {
            buckets[i] = keccak256(abi.encode("bucket", i));
        }
    }

    function _next() internal returns (bytes32) {
        counter++;
        return keccak256(abi.encode("h", counter));
    }

    function fund(uint8 payerSeed, uint8 bucketSeed, uint96 amount) external {
        address payer = payers[payerSeed % 3];
        bytes32 bucket = buckets[bucketSeed % 4];
        uint256 value = bound(amount, 1, 100_000e6);
        vm.prank(payer);
        try escrow.fund(bucket, _next(), address(usdc), value) {
            ghostDeposited += value;
        } catch {}
    }

    function release(uint8 bucketSeed, uint96 amount, address recipient) external {
        if (recipient == address(0) || recipient == address(escrow)) recipient = address(0xC0FFEE);
        bytes32 bucket = buckets[bucketSeed % 4];
        uint256 value = bound(amount, 1, 200_000e6);
        SpacaEscrow.Release memory auth = SpacaEscrow.Release(_next(), bucket, recipient, address(usdc), value, _next(), block.timestamp + 1 hours);
        bytes32 structHash = keccak256(
            abi.encode(escrow.RELEASE_TYPEHASH(), auth.payoutRef, auth.escrowRef, auth.recipient, auth.token, auth.amount, auth.nonce, auth.expiry)
        );
        try escrow.release(auth, _sign(structHash)) {
            ghostPaidOut += value;
        } catch {}
    }

    function refund(uint8 bucketSeed, uint96 amount) external {
        bytes32 bucket = buckets[bucketSeed % 4];
        uint256 value = bound(amount, 1, 200_000e6);
        SpacaEscrow.Refund memory auth = SpacaEscrow.Refund(_next(), bucket, value, _next(), block.timestamp + 1 hours);
        bytes32 structHash = keccak256(abi.encode(escrow.REFUND_TYPEHASH(), auth.payoutRef, auth.escrowRef, auth.amount, auth.nonce, auth.expiry));
        try escrow.refund(auth, _sign(structHash)) {
            ghostPaidOut += value;
        } catch {}
    }

    function reclaim(uint8 bucketSeed, uint32 warpBy) external {
        bytes32 bucket = buckets[bucketSeed % 4];
        vm.warp(block.timestamp + bound(warpBy, 0, 90 days));
        SpacaEscrow.Bucket memory state = escrow.bucketOf(bucket);
        if (state.payer == address(0)) return;
        uint256 value = state.deposited - state.released - state.refunded;
        vm.prank(state.payer);
        try escrow.reclaim(bucket) {
            ghostPaidOut += value;
        } catch {}
    }

    function freeze(uint8 bucketSeed, bool frozen) external {
        bytes32 bucket = buckets[bucketSeed % 4];
        bytes32 nonce = _next();
        uint256 expiry = block.timestamp + 1 hours;
        bytes memory sig = _sign(keccak256(abi.encode(escrow.FREEZE_TYPEHASH(), bucket, frozen, nonce, expiry)));
        try escrow.setFrozen(bucket, frozen, nonce, expiry, sig) {} catch {}
    }

    function togglePause(bool paused) external {
        if (paused) {
            vm.prank(guardian);
            try escrow.pause() {} catch {}
        } else {
            vm.prank(owner);
            try escrow.unpause() {} catch {}
        }
    }

    function _sign(bytes32 structHash) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKey, keccak256(abi.encodePacked("\x19\x01", escrow.domainSeparator(), structHash)));
        return abi.encodePacked(r, s, v);
    }

    function bucketCount() external pure returns (uint256) {
        return 4;
    }
}

contract SpacaEscrowInvariantTest is Test {
    SpacaEscrow internal escrow;
    MockUSDC internal usdc;
    EscrowHandler internal handler;

    function setUp() public {
        uint256 signerKey = 0x51617;
        address owner = makeAddr("owner");
        address guardian = makeAddr("guardian");
        escrow = new SpacaEscrow(owner, vm.addr(signerKey), guardian, 30 days);
        usdc = new MockUSDC();
        vm.prank(owner);
        escrow.setTokenAllowed(address(usdc), true);
        handler = new EscrowHandler(escrow, usdc, signerKey, owner, guardian);
        targetContract(address(handler));
    }

    /// Conservation (§11.5): tokens held equal the sum of every bucket's unreleased balance.
    function invariant_escrow_balance_equals_open_buckets() public view {
        uint256 open;
        for (uint256 i = 0; i < handler.bucketCount(); i++) {
            open += escrow.available(handler.buckets(i));
        }
        assertEq(usdc.balanceOf(address(escrow)), open);
    }

    /// Nothing leaves the escrow except what was deposited: deposits = held + paid out.
    function invariant_outflows_never_exceed_deposits() public view {
        assertEq(handler.ghostDeposited(), usdc.balanceOf(address(escrow)) + handler.ghostPaidOut());
    }

    function invariant_bucket_accounting_is_consistent() public view {
        for (uint256 i = 0; i < handler.bucketCount(); i++) {
            SpacaEscrow.Bucket memory bucket = escrow.bucketOf(handler.buckets(i));
            assertLe(bucket.released + bucket.refunded, bucket.deposited);
        }
    }
}
