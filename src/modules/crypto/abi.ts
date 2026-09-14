/**
 * SpacaEscrow interface the server trusts (master §11.3; contracts/src/SpacaEscrow.sol). Only logs emitted by the
 * network's configured escrow address count; the same signature from any other contract is ignored.
 */
import { parseAbi } from 'viem';

export const SETTLEMENT_EVENTS = parseAbi([
  'event Funded(bytes32 indexed escrowRef, bytes32 indexed paymentRef, address indexed payer, address token, uint256 amount)',
]);

export const ESCROW_ABI = parseAbi([
  'struct Release { bytes32 payoutRef; bytes32 escrowRef; address recipient; address token; uint256 amount; bytes32 nonce; uint256 expiry; }',
  'struct Refund { bytes32 payoutRef; bytes32 escrowRef; uint256 amount; bytes32 nonce; uint256 expiry; }',
  'function fund(bytes32 escrowRef, bytes32 paymentRef, address token, uint256 amount)',
  'function release(Release auth, bytes signature)',
  'function releaseBatch(Release[] auths, bytes[] signatures)',
  'function refund(Refund auth, bytes signature)',
  'function setFrozen(bytes32 escrowRef, bool frozen, bytes32 nonce, uint256 expiry, bytes signature)',
  'function available(bytes32 escrowRef) view returns (uint256)',
  'function payoutUsed(bytes32 payoutRef) view returns (bool)',
  'function paused() view returns (bool)',
  'function releaseSigner() view returns (address)',
  'event Funded(bytes32 indexed escrowRef, bytes32 indexed paymentRef, address indexed payer, address token, uint256 amount)',
  'event Released(bytes32 indexed payoutRef, bytes32 indexed escrowRef, address indexed recipient, address token, uint256 amount)',
  'event Refunded(bytes32 indexed payoutRef, bytes32 indexed escrowRef, address indexed payer, address token, uint256 amount)',
  'event Reclaimed(bytes32 indexed escrowRef, address indexed payer, address token, uint256 amount)',
  'event FrozenSet(bytes32 indexed escrowRef, bool frozen)',
  'error PayoutAlreadyReleased(bytes32 payoutRef)',
  'error BucketFrozen(bytes32 escrowRef)',
  'error InsufficientBucketBalance(bytes32 escrowRef, uint256 available, uint256 requested)',
  'error UnknownBucket(bytes32 escrowRef)',
  'error TokenMismatch(address expected, address actual)',
  'error BadSignature()',
  'error NonceUsed(bytes32 nonce)',
  'error AuthorizationExpired()',
  'error EnforcedPause()',
]);

export const ERC20_ABI = parseAbi([
  'function approve(address spender, uint256 amount) returns (bool)',
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)',
]);

/** token == 0x0 means the chain's native asset (local simulator only; the escrow contract accepts ERC-20 tokens). */
export const NATIVE_TOKEN = '0x0000000000000000000000000000000000000000';
