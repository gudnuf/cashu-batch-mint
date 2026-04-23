import { Mint } from '@cashu/cashu-ts';

export const MAX_COUNT_PER_RUN = 200;

export function isPowerOfTwo(n: number): boolean {
	return Number.isInteger(n) && n > 0 && (n & (n - 1)) === 0;
}

export interface PreflightResult {
	mint: Mint;
	keysetId: string;
	mintInfo: Awaited<ReturnType<Mint['getInfo']>>;
	totalAmount: number;
}

export async function preflight(
	mintUrl: string,
	count: number,
	amount: number,
	unit: string,
): Promise<PreflightResult> {
	if (!Number.isInteger(count) || count < 1 || count > MAX_COUNT_PER_RUN) {
		throw new Error(
			`count must be an integer between 1 and ${MAX_COUNT_PER_RUN}. For N tokens, ` +
				`split into Math.ceil(N/${MAX_COUNT_PER_RUN}) runs.`,
		);
	}
	if (!isPowerOfTwo(amount)) {
		throw new Error(`amount must be a positive power of 2 (got ${amount})`);
	}
	const totalAmount = count * amount;

	const mint = new Mint(mintUrl);

	let mintInfo: Awaited<ReturnType<Mint['getInfo']>>;
	try {
		mintInfo = await mint.getInfo();
	} catch (err) {
		throw new Error(`Failed to reach mint ${mintUrl}: ${(err as Error).message}`);
	}

	const { keysets } = await mint.getKeys();
	const amountKey = String(amount);
	const validKeyset = keysets.find((ks) => {
		if (ks.unit !== unit) return false;
		const keys = ks.keys as Record<string, string>;
		return typeof keys[amountKey] === 'string';
	});
	if (!validKeyset) {
		const availableUnits = [...new Set(keysets.map((k) => k.unit))].join(', ');
		throw new Error(
			`No keyset on ${mintUrl} supports denomination ${amount} for unit "${unit}". ` +
				`Mint offers units: ${availableUnits || '(none)'}.`,
		);
	}

	const bolt11Info = mintInfo.nuts?.['4']?.methods?.find(
		(m: { method: string; unit: string; max_amount?: number }) =>
			m.method === 'bolt11' && m.unit === unit,
	);
	if (!bolt11Info) {
		throw new Error(`Mint ${mintUrl} does not advertise bolt11 mint support for unit "${unit}".`);
	}
	if (typeof bolt11Info.max_amount === 'number' && totalAmount > bolt11Info.max_amount) {
		const maxCount = Math.floor(bolt11Info.max_amount / amount);
		throw new Error(
			`Requested total (${totalAmount}) exceeds mint's advertised max ` +
				`(${bolt11Info.max_amount}). At amount=${amount}, max count per run is ${maxCount}.`,
		);
	}

	return { mint, keysetId: validKeyset.id, mintInfo, totalAmount };
}
