import { getEncodedTokenV4, type Proof, type Token } from '@cashu/cashu-ts';
import { writeManifest, writeTokens, type RunManifest } from './runDir.ts';

// Asserts the minted proofs match the manifest's count/amount/keyset, encodes each
// as a single-proof V4 token without DLEQ, writes them to tokens/, and updates
// the manifest to state: 'complete'. Shared between the initial mint flow and
// resume so the invariants can't drift.
export function encodeAndFinalize(
	runDir: string,
	manifest: RunManifest,
	proofs: Proof[],
): { tokens: string[]; filenames: string[]; manifest: RunManifest } {
	if (proofs.length !== manifest.count) {
		throw new Error(
			`Mint returned ${proofs.length} proofs, expected ${manifest.count}. ` +
				`Preview preserved at ${runDir}/preview.json for manual recovery.`,
		);
	}
	for (let i = 0; i < proofs.length; i++) {
		const p = proofs[i];
		if (p.amount !== manifest.amount) {
			throw new Error(
				`Proof ${i} has amount ${p.amount}, expected ${manifest.amount}. ` +
					`Preview preserved at ${runDir}/preview.json.`,
			);
		}
		if (p.id !== manifest.keysetId) {
			throw new Error(
				`Proof ${i} was signed by keyset ${p.id}, expected ${manifest.keysetId}. ` +
					`Preview preserved at ${runDir}/preview.json.`,
			);
		}
	}

	const tokens = proofs.map((proof) => {
		const token: Token = {
			mint: manifest.mintUrl,
			proofs: [proof],
			unit: manifest.unit,
		};
		// removeDleq=true → smaller tokens, more scannable QR codes.
		return getEncodedTokenV4(token, true);
	});

	const filenames = writeTokens(runDir, tokens);

	const finalManifest: RunManifest = {
		...manifest,
		state: 'complete',
		completedAt: new Date().toISOString(),
		tokenFilenames: filenames,
	};
	writeManifest(runDir, finalManifest);

	return { tokens, filenames, manifest: finalManifest };
}
