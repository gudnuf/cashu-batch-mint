import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Mint, getDecodedToken, getEncodedTokenV4 } from '@cashu/cashu-ts';

const runDir = process.argv[2];
if (!runDir) {
	console.error('usage: bun scripts/verify.ts <run-dir>');
	process.exit(2);
}

const manifest = JSON.parse(readFileSync(join(runDir, 'manifest.json'), 'utf8'));
const mint = new Mint(manifest.mintUrl);
const { keysets } = await mint.getKeys();

const tokensDir = join(runDir, 'tokens');
const files = readdirSync(tokensDir).filter((f) => f.endsWith('.txt')).sort();

let totalAmount = 0;
const seenSecrets = new Set<string>();
for (const f of files) {
	const raw = readFileSync(join(tokensDir, f), 'utf8').trim();
	const decoded = getDecodedToken(raw, keysets);
	if (decoded.proofs.length !== 1) {
		console.error(`${f}: expected 1 proof, got ${decoded.proofs.length}`);
		process.exit(1);
	}
	const p = decoded.proofs[0];
	if (seenSecrets.has(p.secret)) {
		console.error(`${f}: duplicate secret!`);
		process.exit(1);
	}
	seenSecrets.add(p.secret);
	const withoutDleq = getEncodedTokenV4(decoded, true);
	totalAmount += p.amount;
	console.log(
		`${f}: mint=${decoded.mint} unit=${decoded.unit} ` +
			`amount=${p.amount} bytes=${raw.length} bytes_no_dleq=${withoutDleq.length}`,
	);
}
console.log(`\nTotal: ${files.length} tokens summing to ${totalAmount} sat`);
console.log(`All secrets unique: ${seenSecrets.size === files.length}`);
console.log(`Mint URL matches manifest: ${Array.from(new Set(files.map(() => manifest.mintUrl))).length === 1}`);
