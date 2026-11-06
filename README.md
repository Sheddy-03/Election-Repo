# Bende 2023 Election Results Portal

Results-entry portal built from `Bende_2023_Election_Results.xlsx` (214 polling units, 13 wards, 112,155 registered voters; Presidential, Senate and House of Reps).

## Roles
- **Admin** – full control: dashboard (live, auto-refresh), create/disable users, reset passwords, assign polling units, view/correct any result, export CSV, activity log.
- **Data entry agent** – sees only the polling units assigned to them and enters PDP, APC, LP, Accredited, Valid, Rejected and notes for each contest. No dashboard access.

**One polling unit = one agent.** Enforced in the database (a PU has a single `agent_id`) and in the API (assignment to a second agent is refused with the owner named; unit must be unassigned first).

## Business rules (from the workbook)
Total = Valid + Rejected; Turnout = Total ÷ Registered. Status: `Missing` (no figures) → `Incomplete` (<6 figures) → `Check figures` (party sum > valid, total > accredited, accredited > registered, or invalid numbers) → `Complete`. Dashboard totals use Complete results only.

## Run locally
Requires Node.js 22+. With no `DATABASE_URL`, an embedded Postgres (PGlite) stores data in `storage/pgdata`.
```bash
npm install
ADMIN_USERNAME=admin ADMIN_PASSWORD='choose-a-strong-one' npm start   # http://localhost:3000
npm test
```

## Deploy on Vercel + Neon (free)
1. In Vercel: **Add New → Project**, import `Sheddy-03/Election-Repo`. Leave build settings as they are (`vercel.json` handles them).
2. In the project: **Storage → Create Database → Neon (Postgres)** and connect it to the project. This sets `DATABASE_URL` automatically.
3. Add environment variables: `ADMIN_USERNAME` (e.g. `admin`) and `ADMIN_PASSWORD` (a strong password).
4. Deploy. The first request creates the tables, loads the 214 polling units and creates the admin account.

## Config
| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Postgres connection string (set by the Neon integration) |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | first admin, created only if no admin exists |
| `PGLITE_DIR` | local-dev data folder (only when `DATABASE_URL` is unset) |

## Security notes
scrypt password hashing, HttpOnly SameSite=Strict Secure sessions stored in the database, JSON-only + same-origin writes, database-backed login throttling, server-side role and ownership checks, full audit log.
