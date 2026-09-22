# Product intro video — brief for the engineer who builds it

**Read this whole file before starting.** It is written so someone who has never used spaca can understand the
product, then build a thirty-second motion-graphics video that explains it. The reference the owner supplied is a
Swiss/editorial explainer: one idea per beat, oversized type, flat cards, hard cuts, a single accent colour.

**Scope: the video only.** The reference was a screen recording of a storyboard tool, so it showed that tool's own
timeline and beat labels under the picture. Those are **not** part of the video. Render the frame's content alone —
no timeline strip, no beat chips, no ruler, no cursor, no editor chrome of any kind. The beat structure below is how
*you* keep the story straight; the viewer never sees it.

---

## 1. The product, in the order a stranger needs it

**spaca is a marketplace where web3 projects hire creators on X.** A project either books a creator's fixed-price
service or posts a campaign brief that several creators apply to with their own price. Each account is a buyer **or**
a creator, never both.

**The problem it exists for.** Today these deals happen in DMs and group chats. There is no agreed scope, no record,
and no safe way to pay. One side always carries the risk: the project pays first and hopes the creator posts, or the
creator works first and hopes the project pays. A launch that should land as a coordinated wave lands as one post.

**How spaca answers it — this is the part the video has to land.** The money does not go to the creator when the
buyer pays. It is held.

1. The buyer funds the order. Nothing starts until the money is in and the brief is complete.
2. The creator delivers.
3. The buyer approves — or the agreed review window closes without a revision request or a dispute.
4. Only then is the creator paid.

Around that: **one revision is included**, agreed before anyone starts. **A dispute pauses the payout** for a person
to review it. **Every sponsored post is labelled as sponsored** — the product refuses briefs that ask to hide
sponsorship, buy engagement, or promise returns.

That mechanism is the entire pitch. There are no customers, no case studies and no numbers to show, so the mechanism
is what the video sells. Say it plainly and the video works.

---

## 2. The timeline — six beats, about thirty seconds

Five seconds each. One idea on screen at a time; let each one land and hold before cutting. The first three beats are
the problem, the last three are the answer. The cut between beat 3 and beat 4 is the turn of the whole film.

| # | Beat | ≈ | On screen | Copy (exact) |
|---|---|---|---|---|
| 1 | **Hook** | 0–5s | A short list appears line by line. Small hollow circle bullets; the last one fills lime. Tiny type, enormous empty space. | `Let's talk about your launch.` |
| 2 | **The gap** | 5–10s | One enormous word fills and overflows the frame, cropped hard by both edges, drifting slowly sideways. Nothing else. | `One post.` |
| 3 | **The risk** | 10–15s | A row of filled and hollow circles rides a sine wave that dips toward the lower third. A thin card strip slides in above it with an icon and a label. | `Money sent. Nothing back.` |
| 4 | **The turn** | 15–20s | Four flat cards in a row, perfectly still. Soft dark blobs drift across and partly cover them, then slide off and leave the cards clean. | `Or: the money waits.` |
| 5 | **The mechanism** | 20–26s | Four words arrive one at a time, left to right, each landing with a hard stop. The last one is lime. A hairline connects them as they appear. | `Funded → Delivered → Approved → Paid` |
| 6 | **The product** | 26–30s | Empty canvas. The spaca mark and wordmark scale from 96% to 100% together, dead centre, and hold. One line of type under it. | `spaca` / `Creator campaigns for web3 launches, on X.` |

Beat 5 is the one that matters. If time is short, take it from beats 2 and 3, never from 5.

**Optional seventh beat**, only if the video is used somewhere with a call to action: hold on `spaca.xyz` for two
seconds after beat 6. Do not add a button, a price, or "sign up free".

---

## 3. Brand — use the tokens, do not eyeball them

Taken from `src/app/globals.css`; the approved kit is `docs/brand/spaca-brand-kit.html`.

| Role | Value |
|---|---|
| Background | `#121214` |
| Card surface | `#1A1A1D` |
| Card surface, raised | `#232327` |
| Hairline | `rgba(255, 255, 255, 0.09)` |
| Hairline, strong | `rgba(255, 255, 255, 0.16)` |
| Text | `#E8E8EA` |
| Text, muted | `rgba(232, 232, 234, 0.6)` |
| Accent (lime) | `#D6F25E` |
| Accent as text | `#DDF47A` |
| Accent, 13% tint | `rgba(214, 242, 94, 0.13)` |
| Corner radius | **4px** — everywhere, no exceptions |

**Type:** Archivo for display (the oversized words), Geist for body, Geist Mono for labels and any small uppercase
line. Display type is tight-tracked and stretched narrow (`font-stretch: 85%`), as on the site.

**The accent is rationed.** Lime appears on at most one element per beat — the filled bullet, the word `Paid`, the
mark. It is never a large area, never a background, never a gradient.

**No shadows. No gradients. No glow. No bevel. No glassmorphism.** The identity is flat, dark and quiet; a drop
shadow anywhere means it is wrong.

**Motion:** hard cut between beats, never a dissolve. Within a beat, one ease-out move and then stillness. Nothing
loops, nothing pulses, nothing floats for decoration. 30fps.

---

## 4. Rules that are not negotiable

These come from `docs/MARKETING_BRIEF.md` §5 and `AGENTS.md`. A frame that breaks one of them is a reshoot.

- **No numbers of any kind.** No revenue, no user counts, no creator counts, no percentages, no "thousands of people
  are using it". The reference video is full of figures like `$2.78M` and `96% staff left` — those are that product's
  demo data. spaca has had **no real transactions**, so every number would be invented. This is the single easiest
  thing to get caught on.
- **No customer logos, testimonials, ratings or founder quotes.** There are none.
- **Do not write "escrow".** It is on the forbidden list. Say "the money waits", "held until you approve", "funded
  first" — describe the mechanism in plain words.
- **No fee claim.** Not "0% fee", not any rate. The fee is undecided. If fees must be mentioned at all:
  "Fees are published before launch."
- **Do not say "guaranteed", "trustless" or "audited".** The contract has had no independent audit.
- **Crypto and USDC are testnet only** and must be labelled that way if they appear. Better: leave them out of a
  thirty-second film entirely.
- **No promise about returns, price or reach.**
- **Do not name a competitor.**
- No people, faces, stock footage or photography. This is a graphics film.

---

## 5. Output

- **16:9, 1920×1080, 30fps, about 30 seconds**, H.264 `.mp4`.
- Also export a **1:1** and a **9:16** crop if it is going to X — compose so the centre third carries every word.
- **Silent master plus a scored version.** Music, if any, is a minimal electronic pulse with cuts on the beat; no
  voice-over.
- Deliver to `public/landing/` only if the owner asks for it on the site. This brief does not decide that — the
  landing's section list is the owner's own, and adding a video to it is their call, not the video's.

## 6. How to build it, and why that way

**Recommended: render it from HTML in this repo.** Build the six beats as a page using the real CSS custom
properties, drive the animation with CSS, capture frames with Playwright, and assemble with ffmpeg. The repo already
does every step of that — `scripts/brand-shots.ts` drives Playwright against a page and writes PNGs, and the browser
pinned in `E2E_BROWSER_EXECUTABLE` is the one that runs the suite.

The reason is not convenience. It is that the tokens, the font stack, the 4px radius and the exact lime come out
**identical to the product**, because they are the same declarations. Hand-animating in After Effects means matching
by eye, and the brand review will find every place where the eye was wrong.

**If a generative video tool is used instead** (the owner mentioned Higgsfield): use image-to-video, never
text-to-video. Design each beat as a still first, feed the still, and let the model move it. These models cannot
render legible text — every word in §2 must be added as a real type layer in the edit, over the generated motion.
Turn every camera-movement preset off: dolly, orbit and crane on flat 2D graphics look broken.

---

## 7. When it is done

- Play it once with the sound off. If a stranger cannot say what spaca does afterwards, beat 5 is not landing.
- Check every frame against §4. Any number, logo, rating or the word "escrow" means it goes back.
- Check the lime: if it covers more than a small element in any frame, it is too much.
- Check corners: 4px, everywhere.
