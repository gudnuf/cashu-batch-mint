import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { OutputData, type MintPreview } from '@cashu/cashu-ts';

export type RunState =
	| 'preflight-complete'
	| 'quote-created'
	| 'preview-written'
	| 'complete'
	| 'failed';

export interface RunManifest {
	version: 1;
	createdAt: string;
	state: RunState;
	mintUrl: string;
	unit: string;
	amount: number;
	count: number;
	totalAmount: number;
	keysetId: string;
	quote?: {
		quote: string;
		request: string;
		expiry?: number;
		state?: string;
	};
	mintInfo?: {
		name?: string;
		version?: string;
		nut19Supported?: boolean;
	};
	completedAt?: string;
	tokenFilenames?: string[];
	error?: string;
}

function safeHostSegment(raw: string): string {
	try {
		return new URL(raw).host.replace(/[^a-zA-Z0-9.-]/g, '_');
	} catch {
		return raw.replace(/[^a-zA-Z0-9.-]/g, '_').slice(0, 64);
	}
}

function timestampSegment(d: Date): string {
	return d.toISOString().replace(/[:.]/g, '-').replace(/Z$/, 'Z');
}

export function createRunDir(parentDir: string, mintUrl: string, now = new Date()): string {
	mkdirSync(parentDir, { recursive: true });
	const name = `${timestampSegment(now)}-${safeHostSegment(mintUrl)}`;
	const path = join(parentDir, name);
	mkdirSync(path, { recursive: false });
	mkdirSync(join(path, 'tokens'), { recursive: false });
	return path;
}

const MANIFEST_FILE = 'manifest.json';
const PREVIEW_FILE = 'preview.json';

export function writeManifest(runDir: string, manifest: RunManifest): void {
	writeFileSync(
		join(runDir, MANIFEST_FILE),
		JSON.stringify(manifest, null, 2) + '\n',
		{ encoding: 'utf8' },
	);
}

export function readManifest(runDir: string): RunManifest {
	const raw = readFileSync(join(runDir, MANIFEST_FILE), 'utf8');
	return JSON.parse(raw) as RunManifest;
}

interface SerializedOutputData {
	blindedMessage: {
		amount: number;
		B_: string;
		id: string;
	};
	blindingFactor: string;
	secret: string;
}

interface SerializedMintPreview {
	method: string;
	payload: unknown;
	outputData: SerializedOutputData[];
	keysetId: string;
	quote: string;
}

function bytesToHex(b: Uint8Array): string {
	return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}
function hexToBytes(hex: string): Uint8Array {
	if (hex.length % 2 !== 0) throw new Error('invalid hex length');
	const out = new Uint8Array(hex.length / 2);
	for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
	return out;
}

function serializePreview(preview: MintPreview): SerializedMintPreview {
	return {
		method: preview.method,
		payload: preview.payload,
		keysetId: preview.keysetId,
		quote: preview.quote,
		outputData: preview.outputData.map((od) => ({
			blindedMessage: od.blindedMessage as SerializedOutputData['blindedMessage'],
			blindingFactor: od.blindingFactor.toString(10),
			secret: bytesToHex(od.secret),
		})),
	};
}

function deserializePreview(s: SerializedMintPreview): MintPreview {
	return {
		method: s.method,
		payload: s.payload as MintPreview['payload'],
		keysetId: s.keysetId,
		quote: s.quote,
		outputData: s.outputData.map(
			(od) =>
				new OutputData(
					od.blindedMessage,
					BigInt(od.blindingFactor),
					hexToBytes(od.secret),
				),
		),
	};
}

export function writePreview(runDir: string, preview: MintPreview): void {
	writeFileSync(
		join(runDir, PREVIEW_FILE),
		JSON.stringify(serializePreview(preview), null, 2) + '\n',
		{ encoding: 'utf8' },
	);
}

export function readPreview(runDir: string): MintPreview {
	const raw = readFileSync(join(runDir, PREVIEW_FILE), 'utf8');
	return deserializePreview(JSON.parse(raw) as SerializedMintPreview);
}

export function hasPreview(runDir: string): boolean {
	return existsSync(join(runDir, PREVIEW_FILE));
}

export function writeTokens(runDir: string, tokens: string[]): string[] {
	const pad = Math.max(4, String(tokens.length - 1).length);
	const filenames: string[] = [];
	for (let i = 0; i < tokens.length; i++) {
		const name = `${String(i).padStart(pad, '0')}.txt`;
		writeFileSync(join(runDir, 'tokens', name), tokens[i] + '\n', { encoding: 'utf8' });
		filenames.push(`tokens/${name}`);
	}
	return filenames;
}
