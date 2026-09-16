# Brand rollout: campaign board, soft dark, lime (Claude, 2026-09-16)

The identity the user approved on 2026-09-16 — `docs/brand/spaca-brand-kit.html`, version 6 — applied to the product,
following `docs/BRAND_ROLLOUT_PROMPT.md`. Six commits, one per phase; each was type-checked, tested and looked at in the
browser at 1280px and 375px before the next began.

| Phase | Commit | What |
|---|---|---|
| 1 | `5a2e418` | Design tokens and the three typefaces |
| 2 | `35f3803` | Header, menus, buttons, chips, badges, the ruled page frame, `+` section rules |
| 3 | `a5b59f0` | Campaign board, the seven tabs, the seven line drawings |
| 4 | `1c0d30b` | The money band: funds, receipts, payouts, view bonus |
| 5 | `52a510f` | The landing and the last of the app |
| 6 | this commit | Documentation and this record |

## Judgement calls the prompt left open

- **Which button wears the lime.** The prompt allows one prominent action per screen. `.button-dark` was the strongest
  button in the old design and appears roughly once per page (Post a brief, New service, Find paid work), so it takes
  the lime fill; the plain `.button` — a form's submit — became a cell with a rule. If a screen ends up with no lime
  action, the fix is to mark that screen's main action `button-dark`, not to widen the rule.
- **A tab head with nothing open.** The head is meant to carry four real figures. A tab with no open campaign has no
  figures to carry, and inventing zeroes would read as an empty shelf, so that space shows the tab's line drawing
  instead. Figures that the data cannot answer — a per-creator cap nobody set — are dropped rather than faked.
- **Hint text versus the kit's 42%.** The kit sets hint text at 42% white, which measures 3.45:1 on a raised cell and
  fails WCAG AA, and the prompt makes AA a gate. Text that is read (counts, metadata, footer small print, a creator's
  niche) moved to 55%, which is 4.88:1 at worst. What is not read — placeholders, disabled rows, icons, the dotted
  construction lines in the drawings — keeps 42% under a new name, `--hint`.
- **The landing's switch.** The prompt says to ask before removing it, so it stays. Dark is now the default: without a
  stored choice the landing is dark rather than following the system, and light is only an explicit choice. The light
  setting is the same system on paper and also passes AA. If the user would rather the landing be dark only, deleting
  `ThemeToggle` and the `[data-landing-theme="light"]` block is a small change.
- **Campaign rows kept a class rename.** `.campaign-card` became `.board-row`, and the two e2e specs that named the old
  class were updated rather than the class kept for their sake.

## Checks

Run from `outputs/creator-marketplace` with the dev server on 3100 and the embedded Postgres on 55432.

| Check | Result |
|---|---|
| `tsc --noEmit` | clean at every phase |
| `RUN_DB_INTEGRATION=1 vitest run` | 336 passed, 3 skipped (the 3 need `RUN_ANVIL=1`) |
| `playwright test` | 48 passed, 1 failed — see below |
| `tsx scripts/secret-scan.ts` | no secrets or server-only values |
| `tsx scripts/brand-contrast.ts` | 2587 text runs on 9 pages, all meet WCAG AA |
| `LANDING_THEME=light tsx scripts/brand-contrast.ts` | same, with the landing in its light setting |
| `tsx scripts/brand-shots.ts` | 22 screenshots (11 pages × 1280px and 375px), no horizontal overflow |

Two scripts were added for this work and are meant to be re-run:

- `scripts/brand-shots.ts` photographs the eleven pages the rollout is judged on at both widths and fails if any page
  scrolls sideways.
- `scripts/brand-contrast.ts` measures every visible run of text against the colour actually painted behind it and
  fails anything under AA (3:1 for large text). It skips text over an image, where a measurement would be meaningless.

### The one failing browser test

`tests/e2e/publish.spec.ts` fails in `freeLinkedAccountSlot`: creator_d already holds the maximum ten linked X accounts
in the shared dev database, all of them `e2e…` handles from earlier runs, and each is pinned by a published service, so
the helper cannot remove one to make room. It is accumulated test data, not a change here, and it failed the same way
before the first phase. Clearing it means removing those old accounts and the draft services that hold them; that is a
database edit nobody asked for, so it was left alone. Everything else passes.

### Contrast, measured rather than assumed

The pairs the prompt lists were confirmed and the rest measured: `#E8E8EA` on `#121214` is 15.4:1, `#DDF47A` on
`#121214` is 14.9:1, `#121214` on `#D6F25E` is 15.3:1. The semantic colours on their own tints all clear AA, and so
does hint text after the change described above. The check runs over real pages, so it covers combinations no table
would list — a tinted chip inside a raised cell inside the money band, for instance.

## Limits

- The campaign marks on the board look blank in the dev database because its seeded project images are 70-byte
  placeholder PNGs. A campaign with no image at all shows its goal's drawing, which is the path worth looking at.
- The landing's hero sits over a video; text there is white in both settings by design, and the contrast script skips
  it because a moving background has no single colour to measure against.
- `next dev` keeps adding a `<!-- BEGIN:nextjs-agent-rules -->` block to `AGENTS.md`. It is left uncommitted: it is
  tool output, not part of this work, and whether the repo wants it is the owner's call.
