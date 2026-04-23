import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import QRCode from 'qrcode';
import { readManifest } from './runDir.ts';

export type QrFormat = 'png' | 'svg';
export type QrEcLevel = 'L' | 'M' | 'Q' | 'H';

export interface QrOptions {
	runDir: string;
	prefix: string;
	format: QrFormat;
	ecLevel: QrEcLevel;
	sizePx: number;
	marginModules: number;
	outDir?: string;
}

export interface QrResult {
	count: number;
	outDir: string;
	format: QrFormat;
	ecLevel: QrEcLevel;
	dataLen: number;
	qrVersion: number;
}

export async function runQr(opts: QrOptions): Promise<QrResult> {
	const manifest = readManifest(opts.runDir);
	const tokensDir = join(opts.runDir, 'tokens');
	if (!existsSync(tokensDir)) {
		throw new Error(`tokens directory missing: ${tokensDir}`);
	}
	const tokenFiles = readdirSync(tokensDir)
		.filter((f) => f.endsWith('.txt'))
		.sort();
	if (tokenFiles.length === 0) {
		throw new Error(`No .txt tokens in ${tokensDir}`);
	}

	const outDir = opts.outDir ?? join(opts.runDir, 'qr');
	mkdirSync(outDir, { recursive: true });

	const ext = opts.format;
	let probeVersion = 0;
	let probeDataLen = 0;

	for (let i = 0; i < tokenFiles.length; i++) {
		const tokenFile = tokenFiles[i];
		const token = readFileSync(join(tokensDir, tokenFile), 'utf8').trim();
		const data = opts.prefix + token;
		const baseName = tokenFile.replace(/\.txt$/, '');
		const outPath = join(outDir, `${baseName}.${ext}`);

		if (opts.format === 'png') {
			await QRCode.toFile(outPath, data, {
				errorCorrectionLevel: opts.ecLevel,
				width: opts.sizePx,
				margin: opts.marginModules,
				type: 'png',
				color: { dark: '#000000', light: '#FFFFFF' },
			});
		} else {
			const svg = await QRCode.toString(data, {
				errorCorrectionLevel: opts.ecLevel,
				margin: opts.marginModules,
				type: 'svg',
				color: { dark: '#000000', light: '#FFFFFF' },
			});
			writeFileSync(outPath, svg, 'utf8');
		}

		if (i === 0) {
			probeDataLen = data.length;
			const segments = QRCode.create(data, { errorCorrectionLevel: opts.ecLevel });
			probeVersion = segments.version;
		}
	}

	const qrManifest = {
		version: 1,
		generatedAt: new Date().toISOString(),
		sourceRun: opts.runDir,
		sourceMintUrl: manifest.mintUrl,
		sourceCount: manifest.count,
		sourceAmount: manifest.amount,
		sourceUnit: manifest.unit,
		prefix: opts.prefix,
		format: opts.format,
		ecLevel: opts.ecLevel,
		sizePx: opts.format === 'png' ? opts.sizePx : null,
		marginModules: opts.marginModules,
		qrVersion: probeVersion,
		payloadBytes: probeDataLen,
	};
	writeFileSync(
		join(outDir, 'qr-manifest.json'),
		JSON.stringify(qrManifest, null, 2) + '\n',
		'utf8',
	);

	return {
		count: tokenFiles.length,
		outDir,
		format: opts.format,
		ecLevel: opts.ecLevel,
		dataLen: probeDataLen,
		qrVersion: probeVersion,
	};
}
