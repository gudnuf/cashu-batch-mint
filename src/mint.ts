import { Wallet } from '@cashu/cashu-ts';
import qrcodeTerminal from 'qrcode-terminal';
import { preflight } from './preflight.ts';
import {
	createRunDir,
	writeManifest,
	type RunManifest,
} from './runDir.ts';

export interface RunMintOptions {
	mintUrl: string;
	amount: number;
	count: number;
	unit: string;
	outDir: string;
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

export interface QuoteCreated {
	runDir: string;
	invoice: string;
	amount: number;
	unit: string;
	expiresAt: string | null;
	resumeCommand: string;
}

export async function runMint(opts: RunMintOptions): Promise<QuoteCreated> {
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

	const expiresAt = quote.expiry ? new Date(quote.expiry * 1000).toISOString() : null;
	const resumeCommand = `./bin/mint-batch resume ${runDir}`;

	// --- Display invoice + QR + next-step instructions ---
	if (!opts.quiet) {
		console.log('\n--- Lightning invoice (pay to mint) ---');
		const qrArt = await renderQr(quote.request.toUpperCase());
		console.log(qrArt);
		console.log(quote.request);
		console.log(`\nAmount: ${formatSats(totalAmount)} ${opts.unit}`);
		if (expiresAt) console.log(`Expires: ${expiresAt}`);
		console.log('\n--- Next step ---');
		console.log('Pay the invoice above, then run:');
		console.log(`  ${resumeCommand}`);
		console.log('');
		console.log("`resume` will poll the mint until the payment is seen and then issue the tokens.");
	}

	return {
		runDir,
		invoice: quote.request,
		amount: totalAmount,
		unit: opts.unit,
		expiresAt,
		resumeCommand,
	};
}
