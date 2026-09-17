# My services: today's work first, then the catalogue (2026-09-17)

User's instruction: *"ở trong phần my service cái phần giao việc bạn hãy sắp xếp cho mình để dễ quản lí hơn,
biết task nào, đang làm gì chứ không chỉ là 1 đống chữ."*

`/creator/services` was one stack of full-width panels, one per service, each carrying its whole description, its
edit form and its samples — and nothing at all about the work in flight. On the development database that is 427
panels and 5.4 MB of page. A creator could not see what they owed anyone, and could not find a service either.

## What the page is now

1. **Work in progress** — the creator's live orders, grouped by *whose move it is* rather than by status word:
   **Your move** (`FUNDED`, `REVISION_REQUESTED`), **In progress** (`IN_PROGRESS`), **Waiting on the buyer**
   (`AWAITING_PAYMENT`, `DELIVERED`), **On hold** (`DISPUTED`). Each group carries its count and one line saying
   what the state means. Each row is the order title, the buyer, the amount, the state badge and the deadline that
   is actually running — delivery deadline normally, the review window once delivered — with **Overdue** in the
   error colour. Finished orders are not work and are not listed.
2. **New orders** — the pause/resume control, unchanged.
3. **Work samples** — the single add-sample form, unchanged.
4. **Services** — a search box and status chips with counts, then one compact row per service: title, status,
   price, delivery time, sample count, and **how many orders are live on it** (`2 active orders · 1 needs you`,
   linking to the order list). The description, the samples gallery and the edit form moved behind disclosures.

Only the most urgent five orders per group are listed, sorted by the running deadline, with "*N* more in this
state ›" to the order list. The point is a to-do list; 46 rows under one heading is the pile of text again.

## Why it is organised this way

A creator opening this page asks one question first — what do I have to do today. Status words do not answer it:
`FUNDED` and `REVISION_REQUESTED` are different words for "you have not started", while `DELIVERED` and
`AWAITING_PAYMENT` both mean "nothing to do". Grouping by whose move it is answers the question directly, and the
lime accent is spent on **Your move** alone.

## Finding one service among hundreds

Status chips and the search box are plain links and a `GET` form, so both work without JavaScript and can be
bookmarked; they combine, and the count line says "9 of 427 services" whenever a filter is on. Measured on the
development database:

| View | Rows | Page |
|---|---:|---:|
| Everything | 427 | 5.36 MB |
| `?status=DRAFT` | 9 | **282 KB** |
| `?q=bank` | 14 | **349 KB** |

The 5.4 MB full view is the accumulated e2e data the cleanup is still waiting on; the filters make the page usable
in the meantime rather than hiding the problem.

## Keeping the existing tests honest

Five suites drive this page through markup, not roles: `publish`, `digital`, `honest-states`, `work-samples`,
`performance`, plus the shared `createPublishedService` helper. They locate a service with
`page.locator('div.panel').filter({ has: getByRole('heading', { name: title }) })` and then click inside it, so
the rewrite deliberately keeps that contract: each service is still a `div.panel` with an `h3` of its title, and
the `Draft`/`Published` badge, **Publish** / **Pause**, **Open public page ›**, the DIGITAL release form, the
`Work samples (n)` and `Edit service` disclosures all stay inside it and outside any closed disclosure.

For the same reason, order titles in Work in progress are `<strong>`, never headings: an order carries its
service's title, so a heading there would make `div.panel` + heading match two different things. The work section
is a `section.panel`, which `div.panel` does not match at all.

## Results

| Check | Result |
|---|---|
| `tsc --noEmit` | clean |
| `tsx scripts/brand-contrast.ts` | **3416 text runs on 9 pages, all meet WCAG AA** |
| `TZ=UTC playwright test digital.spec.ts` | passed |
| `TZ=UTC playwright test work-samples.spec.ts` | **failed — pre-existing, see below** |

## The work-samples failure is not this change

`work-samples.spec.ts` fails waiting for **Ready** after choosing a file in the Work samples form. It was run
three times:

1. with this rewrite — failed;
2. again with this rewrite — failed the same way;
3. **with `src/app/creator/services/page.tsx` restored to its committed version** (`git checkout --` that one
   file, rewrite kept aside and put back afterwards) — **failed identically**.

So the page is not the cause. Two further facts: no `SAMPLE` upload intent is created at all during the run, so
the browser never starts the upload; and `creator_c` had 12 intents in the last hour, well under the limit of 30,
so it is not rate limiting. A `DIGITAL` upload in the same period finalized normally (`digital.spec.ts` passed),
which is why this is reported rather than guessed at.

The upload path — `src/components/files/file-upload-field.tsx`, `src/components/files/upload.ts`,
`src/modules/storage/{policy,provider,service}.ts` — was rewritten by the parallel session in `c648f12` (item
auction images) while this work was in progress, and that session is still editing. It is theirs to look at, and
patching their files mid-flight would only collide.
