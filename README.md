# cashu-batch-mint

Pay one Lightning invoice to a Cashu mint and receive many single-proof ecash tokens of a fixed denomination. Intended as the producer stage for a later QR-printing workflow.

## Install

```bash
bun install
```

## Usage

```bash
./bin/mint-batch --mint https://testnut.cashu.space --count 5
# defaults: --amount 8192 --unit sat --out ./runs --poll-interval 2000
```

Each run creates `runs/<timestamp>-<mint-host>/` containing:

- `manifest.json` — run config, quote info, keyset, state machine
- `preview.json` — persisted `MintPreview` (blinded outputs + secrets) — written BEFORE the mint request so crashes are recoverable
- `tokens/0000.txt` … — one V4-encoded `cashuB…` token per file, each exactly one proof of `--amount` sats

## Safety model

1. All pre-flight checks happen before any mint call that could cost money.
2. `prepareMint` is local-only; the `MintPreview` is written to disk before the mint HTTP call.
3. On crash after paying the invoice, run `./bin/mint-batch resume <run-dir>` — it replays `completeMint` with the persisted preview. Cashu NUT-19 mints cache responses so retries return identical signatures.
4. The tool refuses to mint at denominations the mint doesn't support, and caps batch size at 200 outputs per run.

## Resume

```bash
./bin/mint-batch resume ./runs/2026-04-23T18-42-01-000Z-testnut.cashu.space
```

## QR codes

Convert a run's tokens into QR code images:

```bash
./bin/tokens-to-qr ./runs/<run-dir> \
  --prefix 'https://agi.cash/receive-cashu-token#' \
  --format png                      # or svg
  --ec-level M                      # L|M|Q|H, default M
  --size 512                        # px per side for PNG
```

Output goes to `<run-dir>/qr/0000.png` … one per source token, plus `qr-manifest.json` recording the config used.

At `--amount 8192` tokens are 229 bytes; with the example URL prefix the full payload is 266 bytes → QR version 12 (65×65 modules, comfortable to scan from paper).

## Tested against

- `https://testnut.cashu.space` (Nutshell 0.20.0) — produces valid 8192-sat tokens, happy path + resume-after-simulated-crash both work.
- Tokens are written without DLEQ by default (`getEncodedTokenV4(token, true)`) so QR codes stay in the scannable size range. If you need DLEQ for receiver-side mint-verification, re-mint after editing `src/mint.ts`.

## Scripts

- `bun run scripts/verify.ts <run-dir>` — decode every token in a run, check uniqueness and sum.
- `bun run scripts/make-partial-run.ts [mintUrl]` — create a partial run (quote created but not minted) to exercise `resume`.
- `bun run scripts/verify-qr.ts <run-dir> [prefix]` — confirm QR version/payload for the tokens in a run.
