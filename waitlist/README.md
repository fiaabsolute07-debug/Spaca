# spaca waitlist

Standalone early-access page, separate from the product app and its database.

- **One required field:** email, plus a project/creator toggle and consent. After joining, visitors see a success message and can optionally add an X handle (or skip).
- **Own database:** local Postgres `spaca_waitlist` or a Supabase project (table `waitlist.signups`, RLS on, no browser access).
- **Onboarding email:** every new signup gets a role-specific welcome email (Resend) with a 7-day link back to the optional X handle step. Without an API key in development, emails are written to `waitlist/.local/emails/` instead of being sent; preview at `/email-preview?role=project|creator`.
- **Stored per signup:** email, role, optional X handle, consent time, attribution (`utm_source`, `utm_medium`, `utm_campaign`, `ref`, external referrer), a salted IP hash for rate limiting, and a hashed one-time token for the optional handle step.
- **Abuse controls:** same-origin check, hidden honeypot field, max 5 signups per IP hash per 10 minutes, duplicate emails get the same success response and are never overwritten.

## Run locally

From the repository root, with the embedded PostgreSQL running (`tsx scripts/postgres.ts start`):

```bash
./node_modules/.bin/tsx waitlist/scripts/migrate.ts
cd waitlist && node ../node_modules/next/dist/bin/next dev --webpack --hostname 127.0.0.1 --port 3200
```

Open http://127.0.0.1:3200. The app resolves `next`, `react` and `postgres` from the root `node_modules`; its own `package.json` lists the same versions for a standalone deploy.

## Connect Supabase and email

Copy `waitlist/.env.example` to `waitlist/.env.local` and fill it in (never commit it):

| Variable | Purpose |
|---|---|
| `WAITLIST_DATABASE_URL` | Supabase transaction pooler connection string (port 6543) for the app |
| `WAITLIST_MIGRATION_URL` | Supabase direct or session connection string (port 5432) for migrations |
| `WAITLIST_IP_SALT` | 16+ character secret for IP hashing |
| `WAITLIST_PUBLIC_URL` | Public origin used in email links |
| `RESEND_API_KEY`, `WAITLIST_EMAIL_FROM` | Resend key and a sender on a domain verified in Resend |
| `WAITLIST_EMAIL_REPLY_TO` | Inbox that receives replies (creator links, unsubscribe requests) |
| `WAITLIST_MAILING_ADDRESS` | Postal address for the email footer |

Then apply migrations to Supabase from the repository root:

```bash
set -a; source waitlist/.env.local; set +a; ./node_modules/.bin/tsx waitlist/scripts/migrate.ts
```

Before going public: replace `[CONTACT EMAIL]` in `/privacy`, set `WAITLIST_MAILING_ADDRESS`, and review both with someone qualified.

## Export signups

```sql
select email, role, x_handle, source->>'utm_source' as utm_source, created_at
from waitlist.signups order by created_at;
```
