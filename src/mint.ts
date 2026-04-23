import {
	Wallet,
	MintQuoteState,
	type MintQuoteBolt11Response,
	type Proof,
} from '@cashu/cashu-ts';
import qrcodeTerminal from 'qrcode-terminal';
import { preflight } from './preflight.ts';
import {
	createRunDir,
	writeManifest,
	writePreview,
	type RunManifest,
} from './runDir.ts';
import { encodeAndFinalize } from './tokens.ts';

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
	const info = mintInfo as { name?: string; version?: string; nuts?: Record<string, unknown> };
	const nut19Supported = Boolean(info.nuts?.['19']);
	let manifest: RunManifest = {
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
			name: info.name,
			version: info.version,
			nut19Supported,
		},
	};
	writeManifest(runDir, manifest);

	if (!opts.quiet) {
		console.log(`-> Run directory: ${runDir}`);
		console.log(`   Mint: ${opts.mintUrl}`);
		console.log(`   Keyset: ${keysetId}`);
		console.log(
			`   Producing ${opts.count} x ${formatSats(opts.amount)} ${opts.unit} = ${formatSats(totalAmount)} ${opts.unit}`,
		);
		if (!nut19Supported) {
			console.log(
				`   [!] WARNING: mint does NOT advertise NUT-19 (cached responses). If this\n` +
					`       process crashes during the mint HTTP call, 'mint-batch resume' will fail\n` +
					`       and the invoice payment is UNRECOVERABLE. Only safe for testnet or\n` +
					`       trivial amounts.`,
			);
		}
	}

	// --- Create wallet + mint quote ---
	const wallet = new Wallet(mint, { unit: opts.unit });
	await wallet.loadMint();
	const quote = await wallet.createMintQuoteBolt11(totalAmount);
	manifest = {
		...manifest,
		state: 'quote-created',
		quote: {
			quote: quote.quote,
			request: quote.request,
			expiry: quote.expiry,
			state: quote.state,
		},
	};
	writeManifest(runDir, manifest);

	// --- Display invoice + QR ---
	if (!opts.quiet) {
		console.log('\n--- Lightning invoice (pay to mint) ---');
		const qrArt = await renderQr(quote.request.toUpperCase());
		console.log(qrArt);
		console.log(quote.request);
		console.log(`\nAmount: ${formatSats(totalAmount)} ${opts.unit}`);
		if (quote.expiry) {
			console.log(`Expires: ${new Date(quote.expiry * 1000).toISOString()}`);
		}
		console.log('\nPolling mint for payment...');
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
			`Quote ${quote.quote} is already in ISSUED state - signatures were already minted ` +
				`for this quote by another process. Cannot recover without the original preview.`,
		);
	}
	// Record the updated state (so manifest reflects reality, not the stale UNPAID).
	manifest = {
		...manifest,
		quote: { ...manifest.quote!, state: paidQuote.state },
	};
	writeManifest(runDir, manifest);

	// --- Prepare mint (local, no network) ---
	const denominations: number[] = Array<number>(opts.count).fill(opts.amount);
	const preview = await wallet.prepareMint('bolt11', totalAmount, paidQuote, { keysetId }, {
		type: 'random',
		denominations,
	});

	// --- Persist preview BEFORE hitting the mint ---
	writePreview(runDir, preview);
	manifest = { ...manifest, state: 'preview-written' };
	writeManifest(runDir, manifest);

	// --- Complete mint (network; NUT-19 idempotent retries safe when supported) ---
	const proofs: Proof[] = await wallet.completeMint(preview);

	// --- Assertions + encode + write tokens + finalize manifest (shared helper) ---
	const { tokens } = encodeAndFinalize(runDir, manifest, proofs);

	if (!opts.quiet) {
		console.log(
			`\nOK Minted ${tokens.length} tokens of ${formatSats(opts.amount)} ${opts.unit} each`,
		);
		console.log(`   Directory: ${runDir}/tokens`);
	}
	return runDir;
}
