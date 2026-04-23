import { Mint, Wallet, MintQuoteState } from '@cashu/cashu-ts';
import qrcodeTerminal from 'qrcode-terminal';
import {
	readManifest,
	readPreview,
	hasPreview,
	writeManifest,
	writePreview,
} from './runDir.ts';
import { encodeAndFinalize } from './tokens.ts';

async function renderQr(text: string): Promise<string> {
	return new Promise((resolve) => {
		qrcodeTerminal.generate(text, { small: true }, (rendered) => resolve(rendered));
	});
}

function explainIssuedWithPreview(runDir: string, quoteId: string, nut19Supported: boolean): Error {
	if (nut19Supported) {
		return new Error(
			`Quote ${quoteId} is in ISSUED state. The mint supports NUT-19 so retries should return ` +
				`cached signatures - this error indicates the retry itself failed for another reason. ` +
				`Inspect the preview at ${runDir}/preview.json and the mint's error response.`,
		);
	}
	return new Error(
		`Quote ${quoteId} is in ISSUED state and this mint does NOT support NUT-19. ` +
			`Signatures were already issued by the mint for the outputs in ${runDir}/preview.json, ` +
			`but the response never reached us and the mint will not replay them. The invoice payment ` +
			`is unrecoverable without out-of-band help from the mint operator.`,
	);
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
	const nut19Supported = Boolean(manifest.mintInfo?.nut19Supported);

	console.log(`Resuming ${runDir} (state: ${manifest.state})`);
	console.log(`  Mint: ${manifest.mintUrl}`);
	console.log(`  Producing ${manifest.count} x ${manifest.amount} ${manifest.unit}`);
	if (!nut19Supported) {
		console.log(
			`  [!] Mint does not advertise NUT-19. If the previous completeMint call reached the\n` +
				`      mint before we crashed, the signatures have already been issued and cannot be\n` +
				`      replayed. Resume will fail fast in that case.`,
		);
	}

	// ---- Case A: preview exists -> jump to completeMint (idempotent on NUT-19 mints) ----
	if (hasPreview(runDir)) {
		if (!manifest.quote) {
			throw new Error(
				`Run dir has preview.json but no quote in manifest - inconsistent state.`,
			);
		}
		const quoteState = await wallet.checkMintQuoteBolt11(manifest.quote.quote);
		if (quoteState.state === MintQuoteState.UNPAID) {
			throw new Error(
				`Quote ${manifest.quote.quote} is UNPAID but preview already exists. ` +
					`This should not happen - did you delete the wrong run dir? Inspect manually.`,
			);
		}
		if (quoteState.state === MintQuoteState.ISSUED && !nut19Supported) {
			throw explainIssuedWithPreview(runDir, manifest.quote.quote, nut19Supported);
		}
		const preview = readPreview(runDir);
		console.log('Preview found on disk; retrying completeMint with same outputs...');
		let proofs;
		try {
			proofs = await wallet.completeMint(preview);
		} catch (err) {
			// If the mint rejected with ISSUED after we sent the preview, translate.
			const msg = (err as Error).message || '';
			if (/issued/i.test(msg)) {
				throw explainIssuedWithPreview(runDir, manifest.quote.quote, nut19Supported);
			}
			throw err;
		}
		encodeAndFinalize(runDir, manifest, proofs);
		console.log(`\nOK Resumed: ${proofs.length} tokens written to ${runDir}/tokens`);
		return;
	}

	// ---- Case B: no preview -> need quote check, maybe poll, then prepareMint ----
	if (!manifest.quote) {
		throw new Error(
			`Run state is "${manifest.state}" with no saved quote. ` +
				`Nothing to resume - start a fresh run.`,
		);
	}
	const current = await wallet.checkMintQuoteBolt11(manifest.quote.quote);

	if (current.state === MintQuoteState.UNPAID) {
		console.log('Quote is still UNPAID. Displaying invoice:');
		console.log('\n--- Lightning invoice (pay to mint) ---');
		const qrArt = await renderQr(manifest.quote.request.toUpperCase());
		console.log(qrArt);
		console.log(manifest.quote.request);
		console.log(`\nPolling mint for payment...`);
		await pollUntilPaid(wallet, manifest.quote.quote, pollIntervalMs);
	} else if (current.state === MintQuoteState.ISSUED) {
		throw new Error(
			`Quote ${current.quote} is in ISSUED state but no preview.json exists in ${runDir}. ` +
				`Signatures were already issued with outputs that were never persisted - this payment ` +
				`is unrecoverable.`,
		);
	}

	const paidQuote = await wallet.checkMintQuoteBolt11(manifest.quote.quote);
	const denominations = Array<number>(manifest.count).fill(manifest.amount);
	const preview = await wallet.prepareMint(
		'bolt11',
		manifest.totalAmount,
		paidQuote,
		{ keysetId: manifest.keysetId },
		{ type: 'random', denominations },
	);
	writePreview(runDir, preview);
	const previewWrittenManifest = {
		...manifest,
		state: 'preview-written' as const,
		quote: { ...manifest.quote, state: paidQuote.state },
	};
	writeManifest(runDir, previewWrittenManifest);

	const proofs = await wallet.completeMint(preview);
	encodeAndFinalize(runDir, previewWrittenManifest, proofs);
	console.log(`\nOK Resumed: ${proofs.length} tokens written to ${runDir}/tokens`);
}

async function pollUntilPaid(wallet: Wallet, quoteId: string, pollIntervalMs: number): Promise<void> {
	while (true) {
		const q = await wallet.checkMintQuoteBolt11(quoteId);
		if (q.state === MintQuoteState.PAID || q.state === MintQuoteState.ISSUED) return;
		await new Promise((r) => setTimeout(r, pollIntervalMs));
	}
}
