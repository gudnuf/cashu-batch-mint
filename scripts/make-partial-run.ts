import { Wallet } from '@cashu/cashu-ts';
import { preflight } from '../src/preflight.ts';
import { createRunDir, writeManifest, type RunManifest } from '../src/runDir.ts';

const mintUrl = process.argv[2] ?? 'https://testnut.cashu.space';
const amount = 8192;
const count = 3;
const unit = 'sat';

const { mint, keysetId, mintInfo, totalAmount } = await preflight(mintUrl, count, amount, unit);
const runDir = createRunDir('./runs', mintUrl);
const wallet = new Wallet(mint, { unit });
await wallet.loadMint();
const quote = await wallet.createMintQuoteBolt11(totalAmount);

const manifest: RunManifest = {
	version: 1,
	createdAt: new Date().toISOString(),
	state: 'quote-created',
	mintUrl,
	unit,
	amount,
	count,
	totalAmount,
	keysetId,
	mintInfo: {
		name: (mintInfo as { name?: string }).name,
		version: (mintInfo as { version?: string }).version,
		nut19Supported: Boolean(
			(mintInfo as { nuts?: Record<string, unknown> }).nuts?.['19'],
		),
	},
	quote: {
		quote: quote.quote,
		request: quote.request,
		expiry: quote.expiry,
		state: quote.state,
	},
};
writeManifest(runDir, manifest);
console.log(`Partial run created at: ${runDir}`);
console.log(`Simulate: quote has been created but not minted. Now run:`);
console.log(`  ./bin/mint-batch resume ${runDir}`);
