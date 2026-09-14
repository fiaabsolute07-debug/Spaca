// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title SpacaEscrow
 * @notice Conditional settlement for spaca orders and campaign pools (master §11.3, §11.7 model A).
 *
 * Trust model, stated plainly (this contract is NOT trustless):
 * - Buyers fund an escrow bucket from their own wallet. Funds leave only through (a) a release signed by the
 *   spaca release signer, (b) a refund signed by the signer, which always goes back to the payer, or (c) the payer
 *   reclaiming what is left after the bucket's reclaim time, if the bucket is not frozen for a dispute.
 * - The signer decides who is paid, capped per bucket by what was deposited. A compromised signer could redirect
 *   an unreleased bucket to another address; the guardian pauses releases, the owner rotates the signer, and
 *   payers can still reclaim after their reclaim time while paused.
 * - The owner (a multisig before real money) configures tokens, signer, guardian and the reclaim delay for future
 *   buckets. There is no owner withdrawal or arbitrary transfer function.
 * - Only allowlisted standard ERC-20 tokens are accepted; fee-on-transfer receipts are refused. On Arc, USDC is used
 *   through its ERC-20 interface (6 decimals), never as the 18-decimal native value.
 */
contract SpacaEscrow is Ownable2Step, Pausable, ReentrancyGuard, EIP712 {
    using SafeERC20 for IERC20;

    struct Bucket {
        address payer;
        address token;
        uint64 reclaimableAt;
        bool frozen;
        uint256 deposited;
        uint256 released;
        uint256 refunded;
    }

    struct Release {
        bytes32 payoutRef;
        bytes32 escrowRef;
        address recipient;
        address token;
        uint256 amount;
        bytes32 nonce;
        uint256 expiry;
    }

    struct Refund {
        bytes32 payoutRef;
        bytes32 escrowRef;
        uint256 amount;
        bytes32 nonce;
        uint256 expiry;
    }

    bytes32 public constant RELEASE_TYPEHASH = keccak256(
        "Release(bytes32 payoutRef,bytes32 escrowRef,address recipient,address token,uint256 amount,bytes32 nonce,uint256 expiry)"
    );
    bytes32 public constant REFUND_TYPEHASH =
        keccak256("Refund(bytes32 payoutRef,bytes32 escrowRef,uint256 amount,bytes32 nonce,uint256 expiry)");
    bytes32 public constant FREEZE_TYPEHASH =
        keccak256("Freeze(bytes32 escrowRef,bool frozen,bytes32 nonce,uint256 expiry)");

    uint64 public constant MIN_RECLAIM_DELAY = 7 days;
    uint64 public constant MAX_RECLAIM_DELAY = 365 days;

    address public releaseSigner;
    address public guardian;
    uint64 public reclaimDelay;

    mapping(address token => bool) public allowedToken;
    mapping(bytes32 escrowRef => Bucket) private _buckets;
    mapping(bytes32 paymentRef => bool) public paymentUsed;
    mapping(bytes32 payoutRef => bool) public payoutUsed;
    mapping(bytes32 nonce => bool) public nonceUsed;

    event Funded(bytes32 indexed escrowRef, bytes32 indexed paymentRef, address indexed payer, address token, uint256 amount);
    event Released(bytes32 indexed payoutRef, bytes32 indexed escrowRef, address indexed recipient, address token, uint256 amount);
    event Refunded(bytes32 indexed payoutRef, bytes32 indexed escrowRef, address indexed payer, address token, uint256 amount);
    event Reclaimed(bytes32 indexed escrowRef, address indexed payer, address token, uint256 amount);
    event FrozenSet(bytes32 indexed escrowRef, bool frozen);
    event ReleaseSignerUpdated(address indexed previous, address indexed current);
    event GuardianUpdated(address indexed previous, address indexed current);
    event TokenAllowed(address indexed token, bool allowed);
    event ReclaimDelayUpdated(uint64 previous, uint64 current);

    error ZeroAddress();
    error ZeroAmount();
    error TokenNotAllowed(address token);
    error PaymentRefUsed(bytes32 paymentRef);
    error PayerMismatch(address expected, address actual);
    error TokenMismatch(address expected, address actual);
    error UnexpectedReceivedAmount(uint256 expected, uint256 received);
    error UnknownBucket(bytes32 escrowRef);
    error BucketFrozen(bytes32 escrowRef);
    error InsufficientBucketBalance(bytes32 escrowRef, uint256 available, uint256 requested);
    error AuthorizationExpired();
    error NonceUsed(bytes32 nonce);
    error PayoutAlreadyReleased(bytes32 payoutRef);
    error BadSignature();
    error NotPayer();
    error NotReclaimableYet(uint64 reclaimableAt);
    error NotGuardianOrOwner();
    error ReclaimDelayOutOfRange(uint64 delay);
    error LengthMismatch();

    constructor(address owner_, address releaseSigner_, address guardian_, uint64 reclaimDelay_)
        Ownable(owner_)
        EIP712("SpacaEscrow", "1")
    {
        if (releaseSigner_ == address(0) || guardian_ == address(0)) revert ZeroAddress();
        _setReclaimDelay(reclaimDelay_);
        releaseSigner = releaseSigner_;
        guardian = guardian_;
        emit ReleaseSignerUpdated(address(0), releaseSigner_);
        emit GuardianUpdated(address(0), guardian_);
    }

    // ----------------------------------------------------------------------------------------------------------
    // Funding
    // ----------------------------------------------------------------------------------------------------------

    /**
     * @notice Deposits `amount` of `token` into bucket `escrowRef`. `paymentRef` identifies this deposit and can be
     * used once. The first deposit fixes the bucket's payer, token and reclaim time; later deposits (pool top-ups)
     * must come from the same payer in the same token.
     */
    function fund(bytes32 escrowRef, bytes32 paymentRef, address token, uint256 amount) external nonReentrant whenNotPaused {
        if (amount == 0) revert ZeroAmount();
        if (!allowedToken[token]) revert TokenNotAllowed(token);
        if (paymentUsed[paymentRef]) revert PaymentRefUsed(paymentRef);
        Bucket storage bucket = _buckets[escrowRef];
        if (bucket.payer == address(0)) {
            bucket.payer = msg.sender;
            bucket.token = token;
            // forge-lint: disable-next-line(unsafe-typecast)
            bucket.reclaimableAt = uint64(block.timestamp) + reclaimDelay; // block.timestamp fits uint64 for billions of years
        } else {
            if (bucket.payer != msg.sender) revert PayerMismatch(bucket.payer, msg.sender);
            if (bucket.token != token) revert TokenMismatch(bucket.token, token);
        }
        paymentUsed[paymentRef] = true;

        uint256 before = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = IERC20(token).balanceOf(address(this)) - before;
        if (received != amount) revert UnexpectedReceivedAmount(amount, received);

        bucket.deposited += amount;
        emit Funded(escrowRef, paymentRef, msg.sender, token, amount);
    }

    // ----------------------------------------------------------------------------------------------------------
    // Signed payouts
    // ----------------------------------------------------------------------------------------------------------

    function release(Release calldata auth, bytes calldata signature) external nonReentrant whenNotPaused {
        _release(auth, signature);
    }

    /// @notice Batches small releases (micro budgets) into one transaction; each keeps its own authorization.
    function releaseBatch(Release[] calldata auths, bytes[] calldata signatures) external nonReentrant whenNotPaused {
        if (auths.length != signatures.length) revert LengthMismatch();
        for (uint256 i = 0; i < auths.length; i++) {
            _release(auths[i], signatures[i]);
        }
    }

    /// @notice Refunds part or all of the unreleased balance to the bucket's payer. The recipient cannot be chosen.
    function refund(Refund calldata auth, bytes calldata signature) external nonReentrant whenNotPaused {
        Bucket storage bucket = _existing(auth.escrowRef);
        _consume(auth.payoutRef, auth.nonce, auth.expiry);
        bytes32 digest = _hashTypedDataV4(
            keccak256(abi.encode(REFUND_TYPEHASH, auth.payoutRef, auth.escrowRef, auth.amount, auth.nonce, auth.expiry))
        );
        _requireSigner(digest, signature);
        _debit(auth.escrowRef, bucket, auth.amount);
        bucket.refunded += auth.amount;
        IERC20(bucket.token).safeTransfer(bucket.payer, auth.amount);
        emit Refunded(auth.payoutRef, auth.escrowRef, bucket.payer, bucket.token, auth.amount);
    }

    /// @notice Freezes a bucket for a dispute (or lifts it). Frozen buckets can neither be released nor reclaimed.
    function setFrozen(bytes32 escrowRef, bool frozen, bytes32 nonce, uint256 expiry, bytes calldata signature) external {
        Bucket storage bucket = _existing(escrowRef);
        if (expiry < block.timestamp) revert AuthorizationExpired();
        if (nonceUsed[nonce]) revert NonceUsed(nonce);
        nonceUsed[nonce] = true;
        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(FREEZE_TYPEHASH, escrowRef, frozen, nonce, expiry)));
        _requireSigner(digest, signature);
        bucket.frozen = frozen;
        emit FrozenSet(escrowRef, frozen);
    }

    /// @notice Incident freeze by the guardian or owner without a signer message (e.g. a suspected signer compromise).
    function guardianFreeze(bytes32 escrowRef) external {
        if (msg.sender != guardian && msg.sender != owner()) revert NotGuardianOrOwner();
        _existing(escrowRef).frozen = true;
        emit FrozenSet(escrowRef, true);
    }

    // ----------------------------------------------------------------------------------------------------------
    // Payer recovery
    // ----------------------------------------------------------------------------------------------------------

    /**
     * @notice The payer takes back what is left once the bucket's reclaim time has passed, unless it is frozen.
     * Works while paused, so buyers can recover funds even if spaca stops operating.
     */
    function reclaim(bytes32 escrowRef) external nonReentrant {
        Bucket storage bucket = _existing(escrowRef);
        if (msg.sender != bucket.payer) revert NotPayer();
        if (bucket.frozen) revert BucketFrozen(escrowRef);
        if (block.timestamp < bucket.reclaimableAt) revert NotReclaimableYet(bucket.reclaimableAt);
        uint256 available = bucket.deposited - bucket.released - bucket.refunded;
        if (available == 0) revert ZeroAmount();
        bucket.refunded += available;
        IERC20(bucket.token).safeTransfer(bucket.payer, available);
        emit Reclaimed(escrowRef, bucket.payer, bucket.token, available);
    }

    // ----------------------------------------------------------------------------------------------------------
    // Administration (no fund movement)
    // ----------------------------------------------------------------------------------------------------------

    function pause() external {
        if (msg.sender != guardian && msg.sender != owner()) revert NotGuardianOrOwner();
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    function setReleaseSigner(address signer) external onlyOwner {
        if (signer == address(0)) revert ZeroAddress();
        address previous = releaseSigner;
        releaseSigner = signer;
        emit ReleaseSignerUpdated(previous, signer);
    }

    function setGuardian(address guardian_) external onlyOwner {
        if (guardian_ == address(0)) revert ZeroAddress();
        address previous = guardian;
        guardian = guardian_;
        emit GuardianUpdated(previous, guardian_);
    }

    function setTokenAllowed(address token, bool allowed) external onlyOwner {
        if (token == address(0)) revert ZeroAddress();
        allowedToken[token] = allowed;
        emit TokenAllowed(token, allowed);
    }

    /// @notice Applies to buckets opened after the change; existing reclaim times never move.
    function setReclaimDelay(uint64 delay) external onlyOwner {
        _setReclaimDelay(delay);
    }

    // ----------------------------------------------------------------------------------------------------------
    // Views
    // ----------------------------------------------------------------------------------------------------------

    function bucketOf(bytes32 escrowRef) external view returns (Bucket memory) {
        return _buckets[escrowRef];
    }

    function available(bytes32 escrowRef) external view returns (uint256) {
        Bucket storage bucket = _buckets[escrowRef];
        return bucket.deposited - bucket.released - bucket.refunded;
    }

    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    // ----------------------------------------------------------------------------------------------------------
    // Internal
    // ----------------------------------------------------------------------------------------------------------

    function _release(Release calldata auth, bytes calldata signature) private {
        if (auth.recipient == address(0)) revert ZeroAddress();
        Bucket storage bucket = _existing(auth.escrowRef);
        if (auth.token != bucket.token) revert TokenMismatch(bucket.token, auth.token);
        _consume(auth.payoutRef, auth.nonce, auth.expiry);
        bytes32 digest = _hashTypedDataV4(
            keccak256(
                abi.encode(
                    RELEASE_TYPEHASH, auth.payoutRef, auth.escrowRef, auth.recipient, auth.token, auth.amount, auth.nonce, auth.expiry
                )
            )
        );
        _requireSigner(digest, signature);
        _debit(auth.escrowRef, bucket, auth.amount);
        bucket.released += auth.amount;
        IERC20(bucket.token).safeTransfer(auth.recipient, auth.amount);
        emit Released(auth.payoutRef, auth.escrowRef, auth.recipient, bucket.token, auth.amount);
    }

    function _existing(bytes32 escrowRef) private view returns (Bucket storage bucket) {
        bucket = _buckets[escrowRef];
        if (bucket.payer == address(0)) revert UnknownBucket(escrowRef);
    }

    function _consume(bytes32 payoutRef, bytes32 nonce, uint256 expiry) private {
        if (expiry < block.timestamp) revert AuthorizationExpired();
        if (nonceUsed[nonce]) revert NonceUsed(nonce);
        if (payoutUsed[payoutRef]) revert PayoutAlreadyReleased(payoutRef);
        nonceUsed[nonce] = true;
        payoutUsed[payoutRef] = true;
    }

    function _debit(bytes32 escrowRef, Bucket storage bucket, uint256 amount) private view {
        if (amount == 0) revert ZeroAmount();
        if (bucket.frozen) revert BucketFrozen(escrowRef);
        uint256 remaining = bucket.deposited - bucket.released - bucket.refunded;
        if (amount > remaining) revert InsufficientBucketBalance(escrowRef, remaining, amount);
    }

    function _requireSigner(bytes32 digest, bytes calldata signature) private view {
        (address recovered, ECDSA.RecoverError recoverError,) = ECDSA.tryRecover(digest, signature);
        if (recoverError != ECDSA.RecoverError.NoError || recovered != releaseSigner) revert BadSignature();
    }

    function _setReclaimDelay(uint64 delay) private {
        if (delay < MIN_RECLAIM_DELAY || delay > MAX_RECLAIM_DELAY) revert ReclaimDelayOutOfRange(delay);
        uint64 previous = reclaimDelay;
        reclaimDelay = delay;
        emit ReclaimDelayUpdated(previous, delay);
    }
}
