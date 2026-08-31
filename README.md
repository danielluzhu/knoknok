# knoknok

A small web app where tenants raise maintenance requests and landlords work them off a to-do
list. New tenant requests go through a triage bot first: it asks a couple of diagnostic
questions, walks the tenant through a safe fix where one exists, and only escalates to the
landlord when it actually needs them.

Bun + libSQL + vanilla JS. No build step, no framework. Runs locally against a SQLite file
and deploys to Vercel against Turso, with the same code and the same SQL.

## Running it

```bash
bun install
bun run seed     # optional demo data
bun start        # http://localhost:4321
bun test         # end-to-end API suite (33 tests, throwaway database)
```

`PORT` and `DB_PATH` are configurable via environment variables; see `.env.example` for the
full list. Setting `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` points local development at a
Turso database instead of the file.

On this machine the app is reachable through the proxy at `https://knoknok-4321.another.ac`.

### Demo accounts (after `bun run seed`)

| Role     | Username | Password      |
| -------- | -------- | ------------- |
| Landlord | `dana`   | `password123` |
| Tenant   | `jo`     | `password123` (unit 2A) |
| Tenant   | `sam`    | `password123` (unit 4B) |

Property join code: `MAPLE1`.

## How it fits together

**Accounts.** A landlord signs up and names their property, which generates a six-character
join code. Tenants sign up with that code plus their unit number, which puts everyone on the
same property. Passwords are hashed with argon2id (`Bun.password`); sessions are random
32-byte tokens in an HttpOnly, SameSite=Lax cookie, valid for 30 days.

**One table for both sides.** A maintenance request and a landlord to-do are the same row in
`tickets`, distinguished by status:

- `triage` — the tenant is still working through it with the bot. Private to that tenant.
- `open` — it's on the landlord's to-do list.
- `closed` — done, with a resolution note recorded.

That's why a landlord's own to-do ("clear the gutters") and an escalated tenant request sit
in one list and close the same way.

**The triage flow.** A tenant opens a request and describes the problem. The bot replies, and
the thread stays in `triage` until one of three things happens:

1. The tenant confirms the problem is fixed → closed, no maintenance visit, `closed_by = 'bot'`.
2. The bot decides it needs a person → status `open`, with a category, a priority, and a
   one-line summary written for the landlord.
3. The tenant hits **Send to landlord now** and skips the rest.

Emergencies (gas, smoke, flooding, sewage, a door that won't lock) skip troubleshooting
entirely and escalate as `urgent` on the first message.

Whichever way it goes, the landlord sees the whole conversation — including everything the
tenant already tried — so nobody has to repeat themselves.

**Closing.** Either side can close a request with a note. Reopening a bot-closed thread puts
it back with the bot; reopening anything else puts it back on the landlord's list.

**To-dos that involve a tenant.** A landlord to-do can be kept internal ("renew the building
insurance") or raised with a specific tenant ("engineer needs access Thursday"). A raised one
appears in that tenant's list marked *from landlord*, and the two of them talk it through in
the same thread — no triage, since the landlord already knows what it is.

**Re-filing.** The bot's category and priority are a starting point, not a verdict. The
landlord can change either from the task header, and the change is written into the thread
(`Dana set priority to urgent and filed it under plumbing.`) so there's a record of who
decided what.

**Unread.** Each side's read position is tracked per thread. The list shows a count of
messages you haven't seen, and the thread draws a line where you left off. Your own messages
and status lines never count against you.

**Messaging.** Separate from requests, each tenant has one standing conversation with their
landlord — for the things that aren't a maintenance ticket ("can I get a second key?", "the
bin collection moves to Wednesday"). The sidebar switches between **Requests** and
**Messages**, and unread counts appear on the tab.

Who can talk to whom falls out of the data model rather than being a rule to enforce: a
property has exactly one landlord, so a conversation is identified by the *tenant* alone.
A tenant may open only their own; a landlord may open any tenant's on their property. There
is no way to address anyone else — a tenant naming another tenant's id, or their own
landlord's id, gets a 404. Tenants cannot message each other at all, and nothing here is a
group thread.

## The bot

`src/bot.ts` exposes one function, `triage(title, history)`, returning a reply plus an action
(`ask` / `resolved` / `escalate`), a category, and a priority. It has two implementations
behind that single interface:

- **Claude** (`claude-opus-5`) when `ANTHROPIC_API_KEY` is set, via structured outputs so the
  action and priority come back as validated fields rather than parsed prose.
- **A built-in diagnostic script** otherwise — keyword-matched playbooks for the common cases
  (GFCI resets, disposal reset buttons, thermostat batteries, P-traps, aerators, appliance
  power-cycles) plus emergency detection.

The fallback isn't only for missing keys: any API error, or a refusal, drops through to the
rules engine, so a request is never lost because the model was unreachable. The badge in the
top bar shows which engine is answering.

To use Claude:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
bun start
```

## Layout

```
server.ts          the listener — node:http, run by Bun locally and Node on Vercel
public/config.js   where the front end looks for the API (empty = same origin)
.github/workflows/ pages.yml publishes public/ to GitHub Pages
src/app.ts         every route, as one Request -> Response function
src/db.ts          schema, the libSQL client, and types
src/auth.ts        password hashing, sessions, throttling, cookies
src/bot.ts         triage — Claude and the rule-based fallback
public/            the whole front end (index.html, app.js, styles.css)
seed.ts            demo property, users, and tickets
test/api.test.ts   end-to-end HTTP tests
```

## API

All routes are JSON and cookie-authenticated.

| Method | Route | Notes |
| ------ | ----- | ----- |
| POST | `/api/signup`, `/api/login`, `/api/logout` | |
| GET | `/api/me` | current user, or `{user: null}` |
| GET | `/api/tickets?status=` | `open`, `closed`, `triage`, `all` |
| POST | `/api/tickets` | tenant → starts triage; landlord → adds a to-do |
| GET | `/api/tickets/:id` | ticket plus full message thread |
| POST | `/api/tickets/:id/messages` | replies; runs the bot while in triage |
| POST | `/api/tickets/:id/update` | landlord only — priority, category, title |
| POST | `/api/tickets/:id/escalate` | tenant skips the bot |
| POST | `/api/tickets/:id/close` / `/reopen` | with an optional resolution note |
| GET | `/api/chats` | conversations — one per tenant for a landlord, one for a tenant |
| GET | `/api/chats/:tenantId` | a conversation and its messages |
| POST | `/api/chats/:tenantId/messages` | send a direct message |
| GET | `/api/property` | landlord only — join code, tenants, counts |
| POST | `/api/password` | change password; signs out every other session |

Tenants can only reach their own tickets; landlords are scoped to their own property. Both
are enforced server-side on every request, not just hidden in the UI.

Failed logins are throttled per username (8 attempts, 15-minute window, in memory).
Changing a password invalidates every other session for that account.

## Tests

`bun test` boots a real server against a throwaway SQLite file and drives it over HTTP the
same way the browser does — signup and join codes, all three triage outcomes, escalation,
closing and reopening, re-filing, tenant-targeted to-dos, unread tracking, direct messaging
and who is allowed to message whom, password change and session invalidation, throttling,
cross-property isolation, and static path traversal.

Point the same suite at any other running copy — a Vercel preview deployment, say — with:

```bash
TEST_BASE_URL=https://your-preview.vercel.app bun test
```

Note that this writes real accounts and tickets, so use a preview and a scratch database
rather than anything you care about.

## Deploying to Vercel

Vercel has no persistent disk, so the SQLite file becomes a [Turso](https://turso.tech)
database. Turso is libSQL — the same SQLite dialect — so no query in this project changes;
only the connection does.

**1. Create the database**

```bash
brew install tursodatabase/tap/turso   # or: curl -sSfL https://get.tur.so/install.sh | bash
turso auth signup
turso db create knoknok
turso db show knoknok --url            # -> libsql://knoknok-you.turso.io
turso db tokens create knoknok         # -> the auth token
```

**2. Deploy**

```bash
npm i -g vercel
vercel link
vercel env add TURSO_DATABASE_URL      # paste the libsql:// URL
vercel env add TURSO_AUTH_TOKEN        # paste the token
vercel env add ANTHROPIC_API_KEY       # optional — triage falls back to rules without it
vercel deploy --prod
```

Or import the repository at [vercel.com/new](https://vercel.com/new) and set the same
environment variables in the project settings. No build command and no output directory are
needed; the defaults are correct.

**3. Seed it, if you want the demo data**

```bash
TURSO_DATABASE_URL=libsql://... TURSO_AUTH_TOKEN=... bun run seed
```

The schema is created on first use — `CREATE TABLE IF NOT EXISTS`, once per instance — so
there is no migration step to run.

### How it maps onto Vercel

There is no `vercel.json` and no build step — the defaults are already right.

| Piece | Where it runs |
| ----- | ------------- |
| `server.ts` | Detected as the server entrypoint and captured as a single Vercel Function that receives every route |
| `public/` | Served by Vercel's CDN before a request reaches the function |

Three things to know if you change the structure:

- **`server.ts` has to keep that name, at the root or in `src/`.** That filename is how
  Vercel finds the entrypoint; rename it and the deployment builds but serves nothing.
- **Keep `server.ts` free of Bun-specific APIs.** It runs on Node in production. Everything
  it uses — `node:http`, `node:fs`, `node:crypto` — works in both, which is why one file
  covers both environments.
- **Sessions and throttling live in the database, not in memory**, because a serverless
  instance is not around long enough to hold state and there may be several of them at once.

## Also hosting the front end on GitHub Pages

GitHub Pages serves files; it cannot run a server or reach a database. So Pages can host the
front end, but the API still has to live somewhere that runs code — Vercel, per the section
above. `.github/workflows/pages.yml` publishes `public/` on every push that touches it.

The two halves then sit on different origins, which changes one thing: **the session cookie
cannot be used.** It is third-party in that arrangement, so Safari drops it and Chrome is
heading the same way. Sign-in therefore also returns the session token in the response body,
and a cross-origin front end holds it and sends `Authorization: Bearer <token>`. The server
accepts either transport. Nothing changes for the Vercel-hosted copy, which stays on the
httpOnly cookie and never puts a token in `localStorage`.

**Setup**

```bash
# 1. Tell the front end where the API is (Settings -> Actions -> Variables, or:)
gh variable set API_BASE_URL --body "https://your-app.vercel.app"

# 2. Tell the API to accept the browser's requests from Pages
vercel env add ALLOWED_ORIGINS     # value: https://your-name.github.io

# 3. Enable Pages with "GitHub Actions" as the source, then run the workflow
gh workflow run pages.yml
```

Both must be set. Without `API_BASE_URL` the published page says it is unconfigured rather
than failing one request at a time; without `ALLOWED_ORIGINS` every call is blocked by the
browser's same-origin policy.

Redeploy the API after changing `ALLOWED_ORIGINS` — it is read at startup.

### Which URL is which

| URL | Serves | Needs |
| --- | ------ | ----- |
| `https://your-app.vercel.app` | The whole app, front end and API | Turso |
| `https://your-name.github.io/knoknok` | The front end only, calling the API above | The two variables above |

The Pages copy is a mirror, not an independent deployment: both talk to the same database, so
an account made on one works on the other.

## Known limits

- The thread polls every 15 seconds rather than using websockets. On Vercel that is a
  function invocation per poll per open tab, which is the main thing to watch on cost.
- No password reset, email, or push notifications.
- One property per user.
- No photo attachments on requests — often the fastest way to describe a leak.
- The Claude triage path is written and type-checked against the SDK but has not been run
  against the live API; without a key the rule-based engine handles everything.
- Triage runs inside the request, so a slow model response counts against the function
  timeout. The rules engine is instant; Claude usually answers in a few seconds.
