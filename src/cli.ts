import { runMint } from './mint.ts';
import { runResume } from './resume.ts';

interface CliOptions {
	mintUrl: string;
	amount: number;
	count: number;
	unit: string;
	outDir: string;
	pollIntervalMs: number;
	quiet: boolean;
}

const DEFAULTS = {
	amount: 8192,
	unit: 'sat',
	outDir: './runs',
	pollIntervalMs: 2000,
};

function usage(exitCode: number): never {
	console.error(
		`Usage:
  mint-batch --mint <url> --count <n> [--amount 8192] [--unit sat]
             [--out ./runs] [--poll-interval 2000] [--quiet]
  mint-batch resume <run-dir> [--poll-interval 2000]

Notes:
  * Max ${200} outputs per run. To mint more, run the script multiple times.
  * --amount must be a positive power of 2 matching a keyset on the mint.
  * Each token is a single proof of the chosen amount, encoded as a V4 (cashuB...) token.
`,
	);
	process.exit(exitCode);
}

function parseIntFlag(raw: string | undefined, name: string): number {
	if (raw == null) throw new Error(`missing value for --${name}`);
	const n = Number(raw);
	if (!Number.isInteger(n) || n <= 0) {
		throw new Error(`--${name} must be a positive integer, got "${raw}"`);
	}
	return n;
}

function parseMintArgs(argv: string[]): CliOptions {
	const opts: Partial<CliOptions> = {
		amount: DEFAULTS.amount,
		unit: DEFAULTS.unit,
		outDir: DEFAULTS.outDir,
		pollIntervalMs: DEFAULTS.pollIntervalMs,
		quiet: false,
	};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		switch (a) {
			case '--mint':
				opts.mintUrl = argv[++i];
				break;
			case '--count':
				opts.count = parseIntFlag(argv[++i], 'count');
				break;
			case '--amount':
				opts.amount = parseIntFlag(argv[++i], 'amount');
				break;
			case '--unit':
				opts.unit = argv[++i];
				break;
			case '--out':
				opts.outDir = argv[++i];
				break;
			case '--poll-interval':
				opts.pollIntervalMs = parseIntFlag(argv[++i], 'poll-interval');
				break;
			case '--quiet':
				opts.quiet = true;
				break;
			case '-h':
			case '--help':
				usage(0);
			// eslint-disable-next-line no-fallthrough
			default:
				throw new Error(`Unknown flag: ${a}`);
		}
	}
	if (!opts.mintUrl) throw new Error('--mint is required');
	if (opts.count == null) throw new Error('--count is required');
	return opts as CliOptions;
}

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	if (argv.length === 0 || argv[0] === '-h' || argv[0] === '--help') usage(0);

	if (argv[0] === 'resume') {
		const runDir = argv[1];
		if (!runDir) {
			console.error('resume: missing <run-dir>');
			usage(2);
		}
		let pollIntervalMs = DEFAULTS.pollIntervalMs;
		for (let i = 2; i < argv.length; i++) {
			if (argv[i] === '--poll-interval') {
				pollIntervalMs = parseIntFlag(argv[++i], 'poll-interval');
			} else {
				throw new Error(`Unknown flag for resume: ${argv[i]}`);
			}
		}
		await runResume(runDir, pollIntervalMs);
		return;
	}

	const opts = parseMintArgs(argv);
	await runMint(opts);
}

main().catch((err) => {
	console.error(`\nerror: ${(err as Error).message}`);
	if (process.env.DEBUG) console.error(err);
	process.exit(1);
});
