import { createHash } from 'node:crypto';

/** Fixed miner fee taken from the swap on either exit, in satoshis. */
export const FEE_SATOSHIS = 1500n;

/** Minimum payout value the off-chain helpers accept. */
export const DUST_LIMIT_SATOSHIS = 546n;

/** State variables every follow-up action needs to rebuild the covenant. */
export const SWAP_FOLLOW_UP_VARIABLES = [
    'swapSatoshis',
    'hashlock',
    'recipientPublicKey',
    'recipientLockingScript',
    'senderLockingScript',
    'timelock',
] as const;

export type SwapState = {
    hashlock: string;
    recipientPublicKey: string;
    recipientLockingScript: string;
    senderLockingScript: string;
    timelock: number;
    swapSatoshis: bigint;
};

/** sha256(preimage) as lowercase hex: the value committed as the hashlock. */
export function buildHashlock(preimage: Uint8Array): string {
    return createHash('sha256').update(preimage).digest('hex');
}
