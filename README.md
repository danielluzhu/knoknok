# knoknok

A small web app where tenants raise maintenance requests and landlords work them off a to-do
list. New tenant requests go through a triage bot first: it asks a couple of diagnostic
questions, walks the tenant through a safe fix where one exists, and only escalates to the
landlord when it actually needs them.

Bun + SQLite + vanilla JS. No build step, no framework, no external services required.

## Running it

```bash
bun install
bun run seed     # optional demo data
bun start        # http://localhost:4321
```

`PORT` and `DB_PATH` are both configurable via environment variables.

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
src/db.ts       schema and types
src/auth.ts     password hashing, sessions, cookies
src/bot.ts      triage — Claude and the rule-based fallback
src/server.ts   HTTP routes and static serving
public/         the whole front end (index.html, app.js, styles.css)
seed.ts         demo property, users, and tickets
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
| POST | `/api/tickets/:id/escalate` | tenant skips the bot |
| POST | `/api/tickets/:id/close` / `/reopen` | with an optional resolution note |
| GET | `/api/property` | landlord only — join code, tenants, counts |

Tenants can only reach their own tickets; landlords are scoped to their own property. Both
are enforced server-side on every request, not just hidden in the UI.

## Known limits

- The thread polls every 15 seconds rather than using websockets.
- No password reset, email, or push notifications.
- One property per user.
- Rate limiting is not implemented — worth adding before this faces the open internet.
