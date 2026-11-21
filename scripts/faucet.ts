import { createHash } from 'node:crypto';

/**
 * Requests Chipnet sats from the BCH Ninja proof-of-work faucet.
 *
 *   tsx scripts/faucet.ts <address> [sats]
 *
 * The faucet gates each request behind a SHA-256 proof-of-work challenge
 * (`sha256("${payload}:${nonce}") <= target`), which is a spam gate designed for
 * automation, not a human CAPTCHA. Testnet only.
 */
const FAUCET = 'https://chipnet.bch.ninja';
const address = process.argv[2];
const sats = Number(process.argv[3] ?? '300000');

if (!address || !address.startsWith('bchtest:')) {
    console.error('usage: tsx scripts/faucet.ts <bchtest:…> [sats]');
    process.exit(1);
}

async function post<T>(path: string, body: unknown): Promise<T> {
    const response = await fetch(`${FAUCET}/api/${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${path} failed (${response.status}): ${text.slice(0, 300)}`);
    return JSON.parse(text) as T;
}

type Challenge = {
    id: string;
    payload: string;
    signature: string;
    target: string;
    expires: number;
    expectedHashes: string;
};

const challenge = await post<Challenge>('challenge', { address, sats });
const target = BigInt(`0x${challenge.target}`);
const started = Date.now();
let nonce = 0n;
for (;;) {
    const digest = createHash('sha256').update(`${challenge.payload}:${nonce}`).digest();
    if (BigInt(`0x${digest.toString('hex')}`) <= target) break;
    nonce += 1n;
    if (Date.now() > challenge.expires) throw new Error('challenge expired');
}

console.log(`proof of work: nonce ${nonce} after ${nonce + 1n} hashes in ${Date.now() - started}ms`);
const result = await post<{ txid?: string; fee?: number; error?: string }>('claim', {
    payload: challenge.payload,
    signature: challenge.signature,
    nonce: nonce.toString(),
});
if (result.error) throw new Error(result.error);
console.log(`faucet txid: ${result.txid ?? '(none)'} (fee ${result.fee ?? '?'} sats)`);
