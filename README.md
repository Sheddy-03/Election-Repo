# Bende 2023 Election Results Portal

Results-entry portal built from `Bende_2023_Election_Results.xlsx` (214 polling units, 13 wards, 112,155 registered voters; Presidential, Senate and House of Reps).

## Roles
- **Admin** – full control: dashboard (live, auto-refresh), create/disable users, reset passwords, assign polling units, view/correct any result, export CSV, activity log.
- **Data entry agent** – sees only the polling units assigned to them and enters PDP, APC, LP, Accredited, Valid, Rejected and notes for each contest. No dashboard access.

**One polling unit = one agent.** Enforced in the database (a PU has a single `agent_id`) and in the API (assignment to a second agent is refused with the owner named; unit must be unassigned first).

## Business rules (from the workbook)
Total = Valid + Rejected; Turnout = Total ÷ Registered. Status: `Missing` (no figures) → `Incomplete` (<6 figures) → `Check figures` (party sum > valid, total > accredited, accredited > registered, or invalid numbers) → `Complete`. Dashboard totals use Complete results only.

## Run
Requires Node.js 22.13+ (uses built-in SQLite; no npm dependencies).
```bash
ADMIN_USERNAME=admin ADMIN_PASSWORD='choose-a-strong-one' npm start
```
Without `ADMIN_PASSWORD`, a random one-time password is printed on first start. Open http://localhost:3000. New users must change their temporary password at first sign-in.

```bash
npm test
```

## Config
| Variable | Purpose | Default |
|---|---|---|
| `PORT` | HTTP port | 3000 |
| `DB_PATH` | SQLite file (put on persistent disk) | `storage/portal.db` |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | first admin (only used if no admin exists) | `admin` / random |
| `COOKIE_SECURE=1` | Secure cookies (set automatically behind HTTPS proxy) | off |

## Deploy
Serve over HTTPS and mount persistent storage for `DB_PATH`. A `Dockerfile` is included (`/data` volume).

## Security notes
scrypt password hashing, HttpOnly SameSite=Strict sessions, JSON-only + same-origin writes, login throttling, server-side role and ownership checks, full audit log.
