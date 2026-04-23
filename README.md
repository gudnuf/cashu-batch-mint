# cashu-batch-mint

Two CLI tools that together turn a Lightning payment into a stack of printable ecash QR codes:

1. **`mint-batch`** — pay one Lightning invoice to a Cashu mint, receive many single-proof ecash tokens of a fixed denomination.
2. **`tokens-to-qr`** — take a run directory of tokens and render one QR code image per token.

Each produced token is one proof of one fixed amount (default 8,192 sat). Tokens are V4-encoded (`cashuB…`) with DLEQ stripped.

## Setup

```bash
cd cashu-batch-mint
bun install
```

Both CLIs live under `./bin/`.

## `mint-batch`

### Mint new tokens

```bash
./bin/mint-batch --mint <url> --count <n> [options]
```

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
| `--poll-interval` | `2000` | Milliseconds between quote-state polls. |
| `--quiet` | off | Suppress banner / invoice QR output. |

Each invocation creates a new subdirectory under `--out`, prints a BOLT11 invoice (plus a terminal QR for scanning with a mobile wallet), polls the mint until paid, then writes one token per file.

### Resume an interrupted run

```bash
./bin/mint-batch resume <run-dir> [--poll-interval 2000]
```

Picks up a run dir that didn't finish. Handles three cases automatically:

- Invoice was never paid → re-prints the invoice and keeps polling.
- Invoice paid, mint HTTP call never completed → replays the mint request.
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
./bin/tokens-to-qr ./runs/<run-dir> \
  --prefix 'https://agi.cash/receive-cashu-token#' \
  --format png
# PNG cards land in ./runs/<run-dir>/qr/
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
- Fully configurable: mint URL, denomination, count, unit, output location.
- Recoverable: crashes after payment resume via `mint-batch resume <run-dir>`.
- Token output is portable: each `.txt` file is a self-contained `cashuB…` V4 token. Any Cashu wallet can redeem it.
- QR images: per-token PNG or SVG, with optional URL prefix so the QR opens in a browser, putting the token in a `#fragment` for client-side receive flows.
- No keys, no secrets, no config files — state lives entirely inside each run directory.
