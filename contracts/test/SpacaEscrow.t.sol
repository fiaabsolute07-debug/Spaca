// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {SpacaEscrow} from "../src/SpacaEscrow.sol";
import {FeeOnTransferToken, MockUSDC, ReentrantToken} from "./mocks/Tokens.sol";

abstract contract EscrowFixture is Test {
    SpacaEscrow internal escrow;
    MockUSDC internal usdc;

    address internal owner = makeAddr("owner");
    address internal guardian = makeAddr("guardian");
    address internal buyer = makeAddr("buyer");
    address internal creator = makeAddr("creator");
    address internal stranger = makeAddr("stranger");
    uint256 internal signerKey = 0xA11CE;
    address internal signer;

    bytes32 internal constant ORDER = keccak256("order:1");
    bytes32 internal constant PAYMENT = keccak256("payment:1");
    uint64 internal constant DELAY = 60 days;

    function setUp() public virtual {
        signer = vm.addr(signerKey);
        escrow = new SpacaEscrow(owner, signer, guardian, DELAY);
        usdc = new MockUSDC();
        vm.prank(owner);
        escrow.setTokenAllowed(address(usdc), true);
        usdc.mint(buyer, 1_000_000e6);
        vm.prank(buyer);
        usdc.approve(address(escrow), type(uint256).max);
    }

    function _fund(bytes32 escrowRef, bytes32 paymentRef, uint256 amount) internal {
        vm.prank(buyer);
        escrow.fund(escrowRef, paymentRef, address(usdc), amount);
    }

    function _releaseAuth(bytes32 payoutRef, bytes32 escrowRef, address recipient, uint256 amount, bytes32 nonce)
        internal
        view
        returns (SpacaEscrow.Release memory auth)
    {
        auth = SpacaEscrow.Release(payoutRef, escrowRef, recipient, address(usdc), amount, nonce, block.timestamp + 1 hours);
    }

    function _signRelease(SpacaEscrow.Release memory auth, uint256 key) internal view returns (bytes memory) {
        bytes32 structHash = keccak256(
            abi.encode(escrow.RELEASE_TYPEHASH(), auth.payoutRef, auth.escrowRef, auth.recipient, auth.token, auth.amount, auth.nonce, auth.expiry)
        );
        return _sign(structHash, key);
    }

    function _signRefund(SpacaEscrow.Refund memory auth, uint256 key) internal view returns (bytes memory) {
        bytes32 structHash = keccak256(abi.encode(escrow.REFUND_TYPEHASH(), auth.payoutRef, auth.escrowRef, auth.amount, auth.nonce, auth.expiry));
        return _sign(structHash, key);
    }

    function _signFreeze(bytes32 escrowRef, bool frozen, bytes32 nonce, uint256 expiry, uint256 key) internal view returns (bytes memory) {
        return _sign(keccak256(abi.encode(escrow.FREEZE_TYPEHASH(), escrowRef, frozen, nonce, expiry)), key);
    }

    function _sign(bytes32 structHash, uint256 key) internal view returns (bytes memory) {
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", escrow.domainSeparator(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }
}

contract SpacaEscrowTest is EscrowFixture {
    function test_fund_records_bucket_and_emits_reference() public {
        vm.expectEmit(address(escrow));
        emit SpacaEscrow.Funded(ORDER, PAYMENT, buyer, address(usdc), 650e6);
        _fund(ORDER, PAYMENT, 650e6);
        SpacaEscrow.Bucket memory bucket = escrow.bucketOf(ORDER);
        assertEq(bucket.payer, buyer);
        assertEq(bucket.token, address(usdc));
        assertEq(bucket.deposited, 650e6);
        assertEq(bucket.reclaimableAt, block.timestamp + DELAY);
        assertEq(usdc.balanceOf(address(escrow)), 650e6);
    }

    function test_fund_refuses_reuse_other_payer_other_token_and_unlisted_tokens() public {
        _fund(ORDER, PAYMENT, 100e6);
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(SpacaEscrow.PaymentRefUsed.selector, PAYMENT));
        escrow.fund(ORDER, PAYMENT, address(usdc), 1e6);

        usdc.mint(stranger, 10e6);
        vm.startPrank(stranger);
        usdc.approve(address(escrow), type(uint256).max);
        vm.expectRevert(abi.encodeWithSelector(SpacaEscrow.PayerMismatch.selector, buyer, stranger));
        escrow.fund(ORDER, keccak256("payment:2"), address(usdc), 1e6);
        vm.stopPrank();

        MockUSDC other = new MockUSDC();
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(SpacaEscrow.TokenNotAllowed.selector, address(other)));
        escrow.fund(keccak256("order:2"), keccak256("payment:3"), address(other), 1e6);

        vm.prank(buyer);
        vm.expectRevert(SpacaEscrow.ZeroAmount.selector);
        escrow.fund(keccak256("order:3"), keccak256("payment:4"), address(usdc), 0);
    }

    function test_pool_top_up_from_same_payer_accumulates() public {
        bytes32 pool = keccak256("pool:1");
        _fund(pool, keccak256("deposit:a"), 300e6);
        _fund(pool, keccak256("deposit:b"), 200e6);
        assertEq(escrow.available(pool), 500e6);
    }

    function test_fee_on_transfer_token_is_refused() public {
        FeeOnTransferToken fee = new FeeOnTransferToken();
        vm.prank(owner);
        escrow.setTokenAllowed(address(fee), true);
        fee.mint(buyer, 100e18);
        vm.startPrank(buyer);
        fee.approve(address(escrow), type(uint256).max);
        vm.expectRevert(abi.encodeWithSelector(SpacaEscrow.UnexpectedReceivedAmount.selector, 100e18, 99e18));
        escrow.fund(ORDER, PAYMENT, address(fee), 100e18);
        vm.stopPrank();
    }

    function test_signed_release_pays_recipient_once() public {
        _fund(ORDER, PAYMENT, 650e6);
        SpacaEscrow.Release memory auth = _releaseAuth(keccak256("payout:1"), ORDER, creator, 650e6, keccak256("n1"));
        bytes memory sig = _signRelease(auth, signerKey);
        vm.prank(stranger); // anyone can relay a signed release
        escrow.release(auth, sig);
        assertEq(usdc.balanceOf(creator), 650e6);
        assertEq(escrow.available(ORDER), 0);

        vm.expectRevert(abi.encodeWithSelector(SpacaEscrow.NonceUsed.selector, keccak256("n1")));
        escrow.release(auth, sig);
        auth.nonce = keccak256("n2");
        bytes memory fresh = _signRelease(auth, signerKey);
        vm.expectRevert(abi.encodeWithSelector(SpacaEscrow.PayoutAlreadyReleased.selector, keccak256("payout:1")));
        escrow.release(auth, fresh);
    }

    function test_release_rejects_wrong_signer_tampering_expiry_token_and_overdraw() public {
        _fund(ORDER, PAYMENT, 100e6);
        SpacaEscrow.Release memory auth = _releaseAuth(keccak256("payout:x"), ORDER, creator, 100e6, keccak256("nx"));

        bytes memory wrongSigner = _signRelease(auth, 0xBAD);
        vm.expectRevert(SpacaEscrow.BadSignature.selector);
        escrow.release(auth, wrongSigner);

        bytes memory sig = _signRelease(auth, signerKey);
        SpacaEscrow.Release memory tampered = auth;
        tampered.recipient = stranger;
        vm.expectRevert(SpacaEscrow.BadSignature.selector);
        escrow.release(tampered, sig);

        SpacaEscrow.Release memory over = _releaseAuth(keccak256("payout:over"), ORDER, creator, 100e6 + 1, keccak256("no"));
        bytes memory overSig = _signRelease(over, signerKey);
        vm.expectRevert(abi.encodeWithSelector(SpacaEscrow.InsufficientBucketBalance.selector, ORDER, 100e6, 100e6 + 1));
        escrow.release(over, overSig);

        SpacaEscrow.Release memory wrongToken = _releaseAuth(keccak256("payout:t"), ORDER, creator, 1e6, keccak256("nt"));
        wrongToken.token = address(0xdead);
        bytes memory wrongTokenSig = _signRelease(wrongToken, signerKey);
        vm.expectRevert(abi.encodeWithSelector(SpacaEscrow.TokenMismatch.selector, address(usdc), address(0xdead)));
        escrow.release(wrongToken, wrongTokenSig);

        vm.warp(auth.expiry + 1);
        vm.expectRevert(SpacaEscrow.AuthorizationExpired.selector);
        escrow.release(auth, sig);
    }

    function test_signature_for_another_contract_or_chain_is_refused() public {
        _fund(ORDER, PAYMENT, 50e6);
        SpacaEscrow.Release memory auth = _releaseAuth(keccak256("payout:c"), ORDER, creator, 50e6, keccak256("nc"));
        SpacaEscrow twin = new SpacaEscrow(owner, signer, guardian, DELAY);
        bytes32 structHash = keccak256(
            abi.encode(escrow.RELEASE_TYPEHASH(), auth.payoutRef, auth.escrowRef, auth.recipient, auth.token, auth.amount, auth.nonce, auth.expiry)
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKey, keccak256(abi.encodePacked("\x19\x01", twin.domainSeparator(), structHash)));
        vm.expectRevert(SpacaEscrow.BadSignature.selector);
        escrow.release(auth, abi.encodePacked(r, s, v));

        bytes memory sig = _signRelease(auth, signerKey);
        vm.chainId(block.chainid + 1);
        vm.expectRevert(SpacaEscrow.BadSignature.selector);
        escrow.release(auth, sig);
    }

    function test_refund_always_goes_to_payer_and_partial_release_keeps_accounting() public {
        _fund(ORDER, PAYMENT, 650e6);
        SpacaEscrow.Refund memory refund = SpacaEscrow.Refund(keccak256("refund:1"), ORDER, 400e6, keccak256("r1"), block.timestamp + 1 hours);
        vm.prank(stranger);
        escrow.refund(refund, _signRefund(refund, signerKey));
        assertEq(usdc.balanceOf(buyer), 1_000_000e6 - 650e6 + 400e6);

        SpacaEscrow.Release memory remainder = _releaseAuth(keccak256("payout:rem"), ORDER, creator, 250e6, keccak256("r2"));
        escrow.release(remainder, _signRelease(remainder, signerKey));
        SpacaEscrow.Bucket memory bucket = escrow.bucketOf(ORDER);
        assertEq(bucket.released, 250e6);
        assertEq(bucket.refunded, 400e6);
        assertEq(escrow.available(ORDER), 0);
        assertEq(usdc.balanceOf(address(escrow)), 0);
    }

    function test_batch_release_is_atomic() public {
        bytes32 pool = keccak256("pool:micro");
        _fund(pool, keccak256("dep"), 10e6);
        SpacaEscrow.Release[] memory auths = new SpacaEscrow.Release[](3);
        bytes[] memory sigs = new bytes[](3);
        for (uint256 i = 0; i < 3; i++) {
            auths[i] = _releaseAuth(keccak256(abi.encode("micro", i)), pool, makeAddr(string(abi.encode(i))), 3e6, keccak256(abi.encode("mn", i)));
            sigs[i] = _signRelease(auths[i], signerKey);
        }
        escrow.releaseBatch(auths, sigs);
        assertEq(escrow.available(pool), 1e6);

        auths[0] = _releaseAuth(keccak256("micro:4"), pool, creator, 1e6, keccak256("mn4"));
        sigs[0] = _signRelease(auths[0], signerKey);
        SpacaEscrow.Release[] memory two = new SpacaEscrow.Release[](2);
        bytes[] memory twoSigs = new bytes[](2);
        two[0] = auths[0];
        twoSigs[0] = sigs[0];
        two[1] = _releaseAuth(keccak256("micro:5"), pool, creator, 1e6, keccak256("mn5"));
        twoSigs[1] = _signRelease(two[1], signerKey);
        vm.expectRevert(abi.encodeWithSelector(SpacaEscrow.InsufficientBucketBalance.selector, pool, 0, 1e6));
        escrow.releaseBatch(two, twoSigs);
        assertEq(escrow.available(pool), 1e6, "failed batch leaves the first item unpaid");
    }

    function test_payer_reclaims_after_delay_unless_frozen_and_even_while_paused() public {
        _fund(ORDER, PAYMENT, 650e6);
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(SpacaEscrow.NotReclaimableYet.selector, uint64(block.timestamp + DELAY)));
        escrow.reclaim(ORDER);
        vm.prank(stranger);
        vm.expectRevert(SpacaEscrow.NotPayer.selector);
        escrow.reclaim(ORDER);

        vm.warp(block.timestamp + DELAY);
        bytes32 nonce = keccak256("freeze");
        escrow.setFrozen(ORDER, true, nonce, block.timestamp + 1 hours, _signFreeze(ORDER, true, nonce, block.timestamp + 1 hours, signerKey));
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(SpacaEscrow.BucketFrozen.selector, ORDER));
        escrow.reclaim(ORDER);

        bytes32 unfreeze = keccak256("unfreeze");
        escrow.setFrozen(ORDER, false, unfreeze, block.timestamp + 1 hours, _signFreeze(ORDER, false, unfreeze, block.timestamp + 1 hours, signerKey));
        vm.prank(guardian);
        escrow.pause();
        vm.prank(buyer);
        escrow.reclaim(ORDER);
        assertEq(usdc.balanceOf(buyer), 1_000_000e6);
        vm.prank(buyer);
        vm.expectRevert(SpacaEscrow.ZeroAmount.selector);
        escrow.reclaim(ORDER);
    }

    function test_frozen_bucket_blocks_release_and_refund() public {
        _fund(ORDER, PAYMENT, 100e6);
        vm.prank(guardian);
        escrow.guardianFreeze(ORDER);
        SpacaEscrow.Release memory auth = _releaseAuth(keccak256("payout:f"), ORDER, creator, 100e6, keccak256("nf"));
        bytes memory sig = _signRelease(auth, signerKey);
        vm.expectRevert(abi.encodeWithSelector(SpacaEscrow.BucketFrozen.selector, ORDER));
        escrow.release(auth, sig);
        SpacaEscrow.Refund memory refund = SpacaEscrow.Refund(keccak256("refund:f"), ORDER, 1e6, keccak256("nrf"), block.timestamp + 1 hours);
        bytes memory refundSig = _signRefund(refund, signerKey);
        vm.expectRevert(abi.encodeWithSelector(SpacaEscrow.BucketFrozen.selector, ORDER));
        escrow.refund(refund, refundSig);
        vm.prank(stranger);
        vm.expectRevert(SpacaEscrow.NotGuardianOrOwner.selector);
        escrow.guardianFreeze(ORDER);
    }

    /// CRY-13: pause stops funding and signed payouts; only the owner unpauses; the owner cannot move funds.
    function test_pause_and_recovery_without_arbitrary_fund_access() public {
        _fund(ORDER, PAYMENT, 100e6);
        vm.prank(stranger);
        vm.expectRevert(SpacaEscrow.NotGuardianOrOwner.selector);
        escrow.pause();
        vm.prank(guardian);
        escrow.pause();

        SpacaEscrow.Release memory auth = _releaseAuth(keccak256("payout:p"), ORDER, creator, 100e6, keccak256("np"));
        bytes memory sig = _signRelease(auth, signerKey);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        escrow.release(auth, sig);
        vm.prank(buyer);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        escrow.fund(keccak256("order:p2"), keccak256("pay:p2"), address(usdc), 1e6);

        vm.prank(guardian);
        vm.expectRevert();
        escrow.unpause();

        // Signer rotation during the incident: the old key's authorization no longer works after unpause.
        uint256 newKey = 0xB0B;
        vm.startPrank(owner);
        escrow.setReleaseSigner(vm.addr(newKey));
        escrow.unpause();
        vm.stopPrank();
        vm.expectRevert(SpacaEscrow.BadSignature.selector);
        escrow.release(auth, sig);
        escrow.release(auth, _signRelease(auth, newKey));
        assertEq(usdc.balanceOf(creator), 100e6);
    }

    function test_admin_bounds_and_two_step_ownership() public {
        vm.startPrank(owner);
        vm.expectRevert(abi.encodeWithSelector(SpacaEscrow.ReclaimDelayOutOfRange.selector, uint64(1 days)));
        escrow.setReclaimDelay(1 days);
        vm.expectRevert(SpacaEscrow.ZeroAddress.selector);
        escrow.setReleaseSigner(address(0));
        escrow.transferOwnership(stranger);
        vm.stopPrank();
        assertEq(escrow.owner(), owner);
        vm.prank(stranger);
        escrow.acceptOwnership();
        assertEq(escrow.owner(), stranger);

        _fund(ORDER, PAYMENT, 10e6);
        uint64 reclaimableAt = escrow.bucketOf(ORDER).reclaimableAt;
        vm.prank(stranger);
        escrow.setReclaimDelay(300 days);
        assertEq(escrow.bucketOf(ORDER).reclaimableAt, reclaimableAt, "existing reclaim times never move");
    }

    function test_reentrant_token_cannot_reenter() public {
        ReentrantToken token = new ReentrantToken();
        vm.prank(owner);
        escrow.setTokenAllowed(address(token), true);
        token.mint(buyer, 100e18);
        vm.startPrank(buyer);
        token.approve(address(escrow), type(uint256).max);
        escrow.fund(ORDER, PAYMENT, address(token), 100e18);
        vm.stopPrank();
        token.arm(address(escrow), ORDER);
        SpacaEscrow.Release memory auth = SpacaEscrow.Release(keccak256("payout:re"), ORDER, creator, address(token), 10e18, keccak256("nre"), block.timestamp + 1 hours);
        bytes32 structHash = keccak256(
            abi.encode(escrow.RELEASE_TYPEHASH(), auth.payoutRef, auth.escrowRef, auth.recipient, auth.token, auth.amount, auth.nonce, auth.expiry)
        );
        bytes memory sig = _sign(structHash, signerKey);
        vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        escrow.release(auth, sig);
    }

    // ------------------------------------------------------------------------------------------------------
    // Fuzz
    // ------------------------------------------------------------------------------------------------------

    function testFuzz_release_and_refund_never_exceed_deposit(uint96 deposit, uint96 releaseAmount, uint96 refundAmount) public {
        uint256 d = bound(deposit, 1, 1_000_000e6);
        uint256 rel = bound(releaseAmount, 1, 2_000_000e6);
        uint256 ref = bound(refundAmount, 1, 2_000_000e6);
        _fund(ORDER, PAYMENT, d);

        SpacaEscrow.Release memory auth = _releaseAuth(keccak256("fz:rel"), ORDER, creator, rel, keccak256("fz:n1"));
        bytes memory sig = _signRelease(auth, signerKey);
        if (rel > d) {
            vm.expectRevert(abi.encodeWithSelector(SpacaEscrow.InsufficientBucketBalance.selector, ORDER, d, rel));
            escrow.release(auth, sig);
            rel = 0;
        } else {
            escrow.release(auth, sig);
        }

        uint256 left = d - rel;
        SpacaEscrow.Refund memory refund = SpacaEscrow.Refund(keccak256("fz:ref"), ORDER, ref, keccak256("fz:n2"), block.timestamp + 1 hours);
        bytes memory refundSig = _signRefund(refund, signerKey);
        if (ref > left) {
            if (left == 0) vm.expectRevert(abi.encodeWithSelector(SpacaEscrow.InsufficientBucketBalance.selector, ORDER, 0, ref));
            else vm.expectRevert(abi.encodeWithSelector(SpacaEscrow.InsufficientBucketBalance.selector, ORDER, left, ref));
            escrow.refund(refund, refundSig);
            ref = 0;
        } else {
            escrow.refund(refund, refundSig);
        }
        assertEq(usdc.balanceOf(address(escrow)), d - rel - ref);
        assertEq(escrow.available(ORDER), d - rel - ref);
        assertEq(usdc.balanceOf(creator) + usdc.balanceOf(buyer) + usdc.balanceOf(address(escrow)), 1_000_000e6);
    }

    function testFuzz_only_the_signer_key_authorizes(uint256 key) public {
        key = bound(key, 1, 115792089237316195423570985008687907852837564279074904382605163141518161494336);
        vm.assume(key != signerKey);
        _fund(ORDER, PAYMENT, 10e6);
        SpacaEscrow.Release memory auth = _releaseAuth(keccak256("fz:key"), ORDER, stranger, 10e6, keccak256("fz:kn"));
        bytes memory sig = _signRelease(auth, key);
        vm.expectRevert(SpacaEscrow.BadSignature.selector);
        escrow.release(auth, sig);
    }
}
