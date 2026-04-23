# cashu-batch-mint

Two CLI tools that together turn a Lightning payment into a stack of printable ecash QR codes:

1. **`mint-batch`** — create a Cashu mint quote (prints the BOLT11 invoice and exits). After you pay the invoice, **`mint-batch resume <run-dir>`** polls the mint until the payment is seen and issues the tokens.
2. **`tokens-to-qr`** — take a run directory of tokens and render one QR code image per token.

The two-step mint flow keeps the default call non-blocking: an agent or script can call `mint-batch` and hand the invoice back to a user, then call `resume` once the user has paid.

Each produced token is one proof of one fixed amount (default 8,192 sat). Tokens are V4-encoded (`cashuB…`) with DLEQ stripped.

## Setup

```bash
cd cashu-batch-mint
bun install
```

Both CLIs live under `./bin/`.

## `mint-batch`

### Create a mint quote (step 1)

```bash
./bin/mint-batch --mint <url> --count <n> [options]
```

Prints the BOLT11 invoice (plus a terminal QR for scanning from a mobile wallet) and exits. The quote is persisted in `runs/<run-dir>/manifest.json`; no tokens are issued until you run `resume`.

Required flags:

| Flag | Value |
|---|---|
| `--mint` | Cashu mint URL (e.g. `https://testnut.cashu.space`) |
| `--count` | Number of tokens to mint (1–200) |

Optional flags:

| Flag | Default | Notes |
|---|---|---|
| `--amount` | `8192` | Per-token denomination in the chosen unit. Must be a power of 2 the mint supports. |
| `--unit` | `sat` | Mint unit. |
| `--out` | `./runs` | Parent directory for run folders. |
| `--quiet` | off | Suppress banner / invoice QR output. |
| `--json` | off | Print a single JSON object describing the quote to stdout (implies `--quiet`). Fields: `runDir`, `invoice`, `amount`, `unit`, `expiresAt`, `resumeCommand`. |

### Issue the tokens (step 2 — after the invoice is paid)

```bash
./bin/mint-batch resume <run-dir> [--poll-interval 2000]
```

Polls the mint until the invoice payment is seen, then calls the mint to issue the signatures and writes the tokens. Handles three cases automatically:

- Invoice not yet paid → re-prints the invoice and polls until it is.
- Invoice paid, mint HTTP call never completed → replays the mint request (idempotent on NUT-19 mints).
- Run already finished → no-op, prints a message.

### Output layout

```
runs/<ISO-timestamp>-<mint-host>/
├── manifest.json        # run config, mint info, quote, state machine, completion timestamp
├── preview.json         # blinded outputs for recovery (present after payment, until tokens written)
└── tokens/
    ├── 0000.txt         # one cashuB… token per file; each is exactly one proof of --amount
    ├── 0001.txt
    └── …
```

After QR generation, a `qr/` subdirectory is added alongside `tokens/`.

### Pre-flight rules

Before any network call that commits money, `mint-batch` checks:

- `count` is in `[1, 200]` (for larger batches, run it multiple times)
- `amount` is a positive power of 2
- The mint advertises `bolt11` for the chosen unit
- The mint has an active keyset that supports `amount` at `unit`
- `count × amount` is within the mint's advertised max (if present)

If the mint does not advertise NUT-19 (cached responses), a visible warning is printed because recovery from a mid-request crash is not possible on such mints.

## `tokens-to-qr`

```bash
./bin/tokens-to-qr <run-dir> [options]
```

Reads all `tokens/*.txt` in the run dir and writes one QR image per token to `<run-dir>/qr/` (or `--out <dir>` if given). Writes `qr-manifest.json` recording the config used.

| Flag | Default | Notes |
|---|---|---|
| `--prefix` | *(empty)* | Prepend a URL to each token. Example: `'https://agi.cash/receive-cashu-token#<token>'` — the `#` fragment keeps the token client-side, so scanning opens the receive page in a browser with the token in the URL. |
| `--format` | `png` | `png` or `svg`. |
| `--ec-level` | `M` | Error correction level: `L` (7%), `M` (15%), `Q` (25%), `H` (30%). |
| `--size` | `512` | PNG size in px per side. Ignored for `svg` (vectors scale infinitely). |
| `--margin` | `2` | Quiet-zone width in modules. |
| `--out` | `<run-dir>/qr` | Output directory. |

Output filenames match the source token filenames (`0000.png` corresponds to `tokens/0000.txt`).

## Common recipes

### Mint 50 tokens for printing

```bash
./bin/mint-batch --mint https://YOUR.mint.url --count 50
# → prints invoice + QR, then exits. Pay the invoice.

./bin/mint-batch resume ./runs/<run-dir>
# → polls the mint until paid, then issues the 50 tokens.

./bin/tokens-to-qr ./runs/<run-dir> \
  --prefix 'https://agi.cash/receive-cashu-token#' \
  --format png
# PNG cards land in ./runs/<run-dir>/qr/
```

### Agent-driven workflow (JSON mode)

```bash
# Agent creates the quote
./bin/mint-batch --mint https://YOUR.mint.url --count 10 --json > quote.json
# Agent reads .invoice from quote.json, hands it to the user
INVOICE=$(jq -r .invoice quote.json)
RUN_DIR=$(jq -r .runDir quote.json)

# User pays the invoice out-of-band

# Agent completes the mint
./bin/mint-batch resume "$RUN_DIR"
./bin/tokens-to-qr "$RUN_DIR" --prefix 'https://agi.cash/receive-cashu-token#'
```

### High-contrast SVG for professional printing

```bash
./bin/tokens-to-qr ./runs/<run-dir> \
  --prefix 'https://agi.cash/receive-cashu-token#' \
  --format svg \
  --ec-level Q \
  --margin 4
```

### Mint, then immediately render a single "smaller" QR run (no URL prefix)

```bash
./bin/mint-batch --mint https://YOUR.mint.url --count 10
./bin/tokens-to-qr ./runs/<run-dir>
# QR codes contain just the cashuB… string — any Cashu-aware scanner can read them.
```

### Against the free testnet mint (auto-pays invoices)

```bash
./bin/mint-batch --mint https://testnut.cashu.space --count 5
./bin/mint-batch resume ./runs/<run-dir>     # testnut auto-pays within seconds
./bin/tokens-to-qr ./runs/<run-dir> --prefix 'https://agi.cash/receive-cashu-token#'
```

## Verification scripts

These don't produce anything, they just sanity-check a run directory:

| Command | What it checks |
|---|---|
| `bun run scripts/verify.ts <run-dir>` | Every token decodes; all secrets unique; amounts sum to manifest total. |
| `bun run scripts/verify-qr.ts <run-dir> [prefix]` | Reports the QR version / module count / payload size that would be used for each token with this prefix. |
| `bun run scripts/redeem-test.ts <run-dir>` | Actually swaps the first 3 tokens back with the mint to prove they're cryptographically valid unspent ecash. *This spends the tokens.* |
| `bun run scripts/make-partial-run.ts [mintUrl]` | Creates a run directory in the "quote-created" state so you can exercise `mint-batch resume`. |

## Capabilities at a glance

- Pay **one** Lightning invoice → produce **N** uniformly-denominated single-proof tokens.
- Two-step flow: `mint-batch` prints the invoice and exits; `mint-batch resume <run-dir>` finishes after the invoice is paid. Non-blocking default suits agent / scripted callers.
- JSON output mode (`--json`) returns a single structured payload so callers can parse the invoice and run dir without text-scraping.
- Fully configurable: mint URL, denomination, count, unit, output location.
- Recoverable: crashes after payment resume via the same `resume` subcommand.
- Token output is portable: each `.txt` file is a self-contained `cashuB…` V4 token. Any Cashu wallet can redeem it.
- QR images: per-token PNG or SVG, with optional URL prefix so the QR opens in a browser, putting the token in a `#fragment` for client-side receive flows.
- No keys, no secrets, no config files — state lives entirely inside each run directory.
