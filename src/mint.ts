import {
	Wallet,
	getEncodedTokenV4,
	MintQuoteState,
	type MintQuoteBolt11Response,
	type Proof,
	type Token,
} from '@cashu/cashu-ts';
import qrcodeTerminal from 'qrcode-terminal';
import { preflight } from './preflight.ts';
import {
	createRunDir,
	writeManifest,
	writePreview,
	writeTokens,
	type RunManifest,
} from './runDir.ts';

export interface RunMintOptions {
	mintUrl: string;
	amount: number;
	count: number;
	unit: string;
	outDir: string;
	pollIntervalMs: number;
	quiet: boolean;
}

async function renderQr(text: string): Promise<string> {
	return new Promise((resolve) => {
		qrcodeTerminal.generate(text, { small: true }, (rendered) => resolve(rendered));
	});
}

function formatSats(n: number): string {
	return n.toLocaleString('en-US');
}

async function pollUntilPaid(
	wallet: Wallet,
	quote: MintQuoteBolt11Response,
	pollIntervalMs: number,
	onTick?: (state: string, elapsedMs: number) => void,
): Promise<MintQuoteBolt11Response> {
	const expiryMs = quote.expiry ? quote.expiry * 1000 : Number.POSITIVE_INFINITY;
	const start = Date.now();
	let current = quote;
	while (true) {
		current = await wallet.checkMintQuoteBolt11(quote.quote);
		const elapsed = Date.now() - start;
		onTick?.(current.state, elapsed);
		if (current.state === MintQuoteState.PAID || current.state === MintQuoteState.ISSUED) {
			return current;
		}
		if (Date.now() > expiryMs) {
			throw new Error(
				`Mint quote expired at ${new Date(expiryMs).toISOString()} without being paid.`,
			);
		}
		await new Promise((r) => setTimeout(r, pollIntervalMs));
	}
}

function encodeSingleProofTokens(mintUrl: string, unit: string, proofs: Proof[]): string[] {
	return proofs.map((proof) => {
		const token: Token = {
			mint: mintUrl,
			proofs: [proof],
			unit,
		};
		// removeDleq=true → smaller tokens, more scannable QR codes.
		return getEncodedTokenV4(token, true);
	});
}

export async function runMint(opts: RunMintOptions): Promise<string> {
	// --- Preflight (no money at risk) ---
	const { mint, keysetId, mintInfo, totalAmount } = await preflight(
		opts.mintUrl,
		opts.count,
		opts.amount,
		opts.unit,
	);

	// --- Run directory ---
	const runDir = createRunDir(opts.outDir, opts.mintUrl);
	const manifest: RunManifest = {
		version: 1,
		createdAt: new Date().toISOString(),
		state: 'preflight-complete',
		mintUrl: opts.mintUrl,
		unit: opts.unit,
		amount: opts.amount,
		count: opts.count,
		totalAmount,
		keysetId,
		mintInfo: {
			name: (mintInfo as { name?: string }).name,
			version: (mintInfo as { version?: string }).version,
			nut19Supported: Boolean((mintInfo as { nuts?: Record<string, unknown> }).nuts?.['19']),
		},
	};
	writeManifest(runDir, manifest);

	if (!opts.quiet) {
		console.log(`→ Run directory: ${runDir}`);
		console.log(`  Mint: ${opts.mintUrl}`);
		console.log(`  Keyset: ${keysetId}`);
		console.log(`  Producing ${opts.count} × ${formatSats(opts.amount)} ${opts.unit} = ${formatSats(totalAmount)} ${opts.unit}`);
	}

	// --- Create wallet + mint quote ---
	const wallet = new Wallet(mint, { unit: opts.unit });
	await wallet.loadMint();
	const quote = await wallet.createMintQuoteBolt11(totalAmount);
	manifest.state = 'quote-created';
	manifest.quote = {
		quote: quote.quote,
		request: quote.request,
		expiry: quote.expiry,
		state: quote.state,
	};
	writeManifest(runDir, manifest);

	// --- Display invoice + QR ---
	if (!opts.quiet) {
		console.log('\n─── Lightning invoice (pay to mint) ───');
		const qrArt = await renderQr(quote.request.toUpperCase());
		console.log(qrArt);
		console.log(quote.request);
		console.log(`\nAmount: ${formatSats(totalAmount)} ${opts.unit}`);
		if (quote.expiry) {
			console.log(`Expires: ${new Date(quote.expiry * 1000).toISOString()}`);
		}
		console.log('\nPolling mint for payment…');
	}

	// --- Poll for payment ---
	let lastState = '';
	const paidQuote = await pollUntilPaid(wallet, quote, opts.pollIntervalMs, (state) => {
		if (state !== lastState && !opts.quiet) {
			process.stdout.write(`  state: ${state}\n`);
			lastState = state;
		}
	});
	if (paidQuote.state === MintQuoteState.ISSUED) {
		throw new Error(
			`Quote ${quote.quote} is already in ISSUED state — signatures were already minted ` +
				`for this quote by another process. Cannot recover without the original preview.`,
		);
	}

	// --- Prepare mint (local) ---
	const denominations: number[] = Array<number>(opts.count).fill(opts.amount);
	const preview = await wallet.prepareMint('bolt11', totalAmount, paidQuote, { keysetId }, {
		type: 'random',
		denominations,
	});

	// --- Persist preview BEFORE hitting the mint ---
	writePreview(runDir, preview);
	manifest.state = 'preview-written';
	writeManifest(runDir, manifest);

	// --- Complete mint (network; NUT-19 idempotent retries safe) ---
	const proofs: Proof[] = await wallet.completeMint(preview);
	if (proofs.length !== opts.count) {
		throw new Error(
			`Mint returned ${proofs.length} proofs, expected ${opts.count}. ` +
				`Preview preserved at ${runDir}/preview.json for manual recovery.`,
		);
	}
	for (const p of proofs) {
		if (p.amount !== opts.amount) {
			throw new Error(
				`Mint returned a proof of ${p.amount} when ${opts.amount} was requested. ` +
					`Preview preserved at ${runDir}/preview.json.`,
			);
		}
	}

	// --- Encode + write tokens ---
	const tokens = encodeSingleProofTokens(opts.mintUrl, opts.unit, proofs);
	const filenames = writeTokens(runDir, tokens);

	manifest.state = 'complete';
	manifest.completedAt = new Date().toISOString();
	manifest.tokenFilenames = filenames;
	writeManifest(runDir, manifest);

	if (!opts.quiet) {
		console.log(`\n✓ Minted ${tokens.length} tokens of ${formatSats(opts.amount)} ${opts.unit} each`);
		console.log(`  Directory: ${runDir}/tokens`);
	}
	return runDir;
}
