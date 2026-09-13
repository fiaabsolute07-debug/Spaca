/**
 * Settlement contract events the server trusts (master §11.3). Only logs emitted by the network's configured
 * settlement address count; the same signature from any other contract is ignored.
 */
import { parseAbi } from 'viem';

export const SETTLEMENT_EVENTS = parseAbi([
  'event OrderFunded(bytes32 indexed paymentRef, address indexed payer, address indexed token, uint256 amount)',
]);

/** token == 0x0 means the chain's native asset. */
export const NATIVE_TOKEN = '0x0000000000000000000000000000000000000000';
