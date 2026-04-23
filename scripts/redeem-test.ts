// End-to-end validity test: mints a small batch, then uses wallet.receive on
// one produced token to force the mint to swap it. If the swap succeeds the
// mint recognized the proof as valid and unspent.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Mint, Wallet, getDecodedToken } from '@cashu/cashu-ts';

const runDir = process.argv[2];
if (!runDir) {
	console.error('usage: bun scripts/redeem-test.ts <run-dir>');
	process.exit(2);
}

const manifest = JSON.parse(readFileSync(join(runDir, 'manifest.json'), 'utf8'));
const mint = new Mint(manifest.mintUrl);
const wallet = new Wallet(mint, { unit: manifest.unit });
await wallet.loadMint();

const tokenFiles = readdirSync(join(runDir, 'tokens'))
	.filter((f) => f.endsWith('.txt'))
	.sort();

console.log(`Mint: ${manifest.mintUrl}`);
console.log(`Testing ${Math.min(3, tokenFiles.length)} tokens from ${runDir} via wallet.receive():\n`);

const { keysets } = await mint.getKeys();

let totalReceived = 0;
for (const tf of tokenFiles.slice(0, 3)) {
	const tokenStr = readFileSync(join(runDir, 'tokens', tf), 'utf8').trim();
	const decoded = getDecodedToken(tokenStr, keysets);
	const p = decoded.proofs[0];
	// A successful receive is proof that the mint accepted the proof as valid
	// and unspent (it swaps it server-side for fresh proofs).
	const newProofs = await wallet.receive(tokenStr);
	const received = newProofs.reduce((s, pf) => s + pf.amount, 0);
	const fee = p.amount - received;
	totalReceived += received;
	console.log(
		`${tf}: presented=${p.amount} received=${received} fee=${fee} (${newProofs.length} new proof(s))`,
	);
}
console.log(`\nOK: mint accepted and swapped all 3 tokens. Total received: ${totalReceived} ${manifest.unit}`);

