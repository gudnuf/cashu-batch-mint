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
console.log(`Testing ${Math.min(3, tokenFiles.length)} tokens from ${runDir}:\n`);

const { keysets } = await mint.getKeys();

for (const tf of tokenFiles.slice(0, 3)) {
	const tokenStr = readFileSync(join(runDir, 'tokens', tf), 'utf8').trim();
	const decoded = getDecodedToken(tokenStr, keysets);
	const p = decoded.proofs[0];

	// Check proof state via NUT-07 (UNSPENT = valid and unused)
	const stateResp = await mint.check({ Ys: [] as string[], proofs: decoded.proofs } as never);
	console.log(`${tf}: ${p.amount} ${decoded.unit}, mint sees state: ${JSON.stringify(stateResp)}`);
}

// Do an actual receive/swap on token 0 to prove the proofs spend cleanly.
const firstTokenStr = readFileSync(join(runDir, 'tokens', tokenFiles[0]), 'utf8').trim();
console.log(`\nAttempting wallet.receive on ${tokenFiles[0]}…`);
const newProofs = await wallet.receive(firstTokenStr);
console.log(
	`✓ Received ${newProofs.length} new proof(s) totaling ${newProofs.reduce((s, p) => s + p.amount, 0)} ${manifest.unit}`,
);
console.log(
	`  Mint issued fresh proofs for our token, confirming it was a valid unspent ecash note.`,
);
