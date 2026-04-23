import {
	Mint,
	Wallet,
	MintQuoteState,
	getEncodedTokenV4,
	type Proof,
	type Token,
} from '@cashu/cashu-ts';
import qrcodeTerminal from 'qrcode-terminal';
import {
	readManifest,
	readPreview,
	hasPreview,
	writeManifest,
	writePreview,
	writeTokens,
} from './runDir.ts';

async function renderQr(text: string): Promise<string> {
	return new Promise((resolve) => {
		qrcodeTerminal.generate(text, { small: true }, (rendered) => resolve(rendered));
	});
}

export async function runResume(runDir: string, pollIntervalMs = 2000): Promise<void> {
	const manifest = readManifest(runDir);
	if (manifest.state === 'complete') {
		console.log(`Run already complete: ${runDir}`);
		return;
	}

	const mint = new Mint(manifest.mintUrl);
	const wallet = new Wallet(mint, { unit: manifest.unit });
	await wallet.loadMint();

	console.log(`Resuming ${runDir} (state: ${manifest.state})`);
	console.log(`  Mint: ${manifest.mintUrl}`);
	console.log(`  Producing ${manifest.count} × ${manifest.amount} ${manifest.unit}`);

	// ---- Case A: preview exists → jump straight to completeMint ----
	if (hasPreview(runDir)) {
		const preview = readPreview(runDir);
		console.log('Preview found on disk; retrying completeMint (NUT-19 idempotent)…');
		const proofs = await wallet.completeMint(preview);
		finish(runDir, manifest, proofs);
		return;
	}

	// ---- Case B: no preview yet → need quote, maybe pay, then prepareMint ----
	if (!manifest.quote) {
		throw new Error(
			`Run state is "${manifest.state}" with no saved quote. ` +
				`Nothing to resume — start a fresh run.`,
		);
	}
	const current = await wallet.checkMintQuoteBolt11(manifest.quote.quote);

	if (current.state === MintQuoteState.UNPAID) {
		console.log('Quote is still UNPAID. Displaying invoice:');
		console.log('\n─── Lightning invoice (pay to mint) ───');
		const qrArt = await renderQr(manifest.quote.request.toUpperCase());
		console.log(qrArt);
		console.log(manifest.quote.request);
		console.log(`\nPolling mint for payment…`);
		await pollUntilPaid(wallet, manifest.quote.quote, pollIntervalMs);
	} else if (current.state === MintQuoteState.ISSUED) {
		throw new Error(
			`Quote ${current.quote} is in ISSUED state but no preview.json exists in ${runDir}. ` +
				`Signatures were already issued with different outputs — unrecoverable from this run dir.`,
		);
	}

	const denominations = Array<number>(manifest.count).fill(manifest.amount);
	const paidQuote = await wallet.checkMintQuoteBolt11(manifest.quote.quote);
	const preview = await wallet.prepareMint(
		'bolt11',
		manifest.totalAmount,
		paidQuote,
		{ keysetId: manifest.keysetId },
		{ type: 'random', denominations },
	);
	writePreview(runDir, preview);
	const nextManifest = { ...manifest, state: 'preview-written' as const };
	writeManifest(runDir, nextManifest);

	const proofs = await wallet.completeMint(preview);
	finish(runDir, nextManifest, proofs);
}

function finish(
	runDir: string,
	manifest: ReturnType<typeof readManifest>,
	proofs: Proof[],
): void {
	if (proofs.length !== manifest.count) {
		throw new Error(
			`Mint returned ${proofs.length} proofs, expected ${manifest.count}. ` +
				`Preview preserved at ${runDir}/preview.json.`,
		);
	}
	const tokens = proofs.map((proof) => {
		const token: Token = { mint: manifest.mintUrl, proofs: [proof], unit: manifest.unit };
		return getEncodedTokenV4(token, true);
	});
	const filenames = writeTokens(runDir, tokens);
	writeManifest(runDir, {
		...manifest,
		state: 'complete',
		completedAt: new Date().toISOString(),
		tokenFilenames: filenames,
	});
	console.log(`\n✓ Resumed: ${tokens.length} tokens written to ${runDir}/tokens`);
}

async function pollUntilPaid(wallet: Wallet, quoteId: string, pollIntervalMs: number): Promise<void> {
	while (true) {
		const q = await wallet.checkMintQuoteBolt11(quoteId);
		if (q.state === MintQuoteState.PAID || q.state === MintQuoteState.ISSUED) return;
		await new Promise((r) => setTimeout(r, pollIntervalMs));
	}
}
