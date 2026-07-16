# HiringFlow — Project Instructions

## Git push policy (overrides global)

For this project, the global rule "do NOT push to `main` without explicit confirmation" is **lifted**. You are authorized to push directly to `main` without asking, including:

- `git commit` + `git push origin main` after making changes
- Pushing fixes, features, or refactors directly to `main`

This is a single-developer project where rapid iteration on `main` is the intended workflow. Continue to:
- Stage only files relevant to the current change (avoid `git add -A`)
- Never force-push or rewrite history without explicit confirmation
- Never skip hooks (`--no-verify`) without explicit confirmation
<!-- fixloop:claude-section -->
## FixLoop — production error logs (auto-fetch on bug reports + dev loop)

This repo is wired to **multiple FixLoop projects**. Two behaviors expected of the coding agent reading this file:

### 1. SDK install (skip per-side if already in package.json)

- **frontend** (`hiringflow-frontend`) — SDK `@fixprompt/browser` — for: Next.js client component errors.
- **server** (`hiringflow`) — SDK `@geos/loghub-client (github:goscha01/geos-loghub-client — @fixprompt/node not yet on npm)` — for: Next.js server actions, Prisma, Stripe.

### 2. Pick which project to query

Match the bug surface to one of the slugs above. The env-var prefix mirrors the prefix.

### 3. Debug loop on bug reports

Trigger phrases: "X is broken", "doesn't work", "crashes", "is failing", pasted error stacks.

Loop until the log query returns no new matches:

1. **Fetch recent errors** for the relevant project. Pick the matching env vars from `.env.local`:
   ```sh
   # frontend (hiringflow-frontend)
   curl -sH "x-fixprompt-read-token: $FIXPROMPT_FRONTEND_READ_TOKEN" \
     "$FIXPROMPT_BROKER_URL/projects/$FIXPROMPT_FRONTEND_PROJECT_ID/logs?since=24h&level=error,warn,fatal&limit=200"
   # server (hiringflow)
   curl -sH "x-fixprompt-read-token: $FIXPROMPT_SERVER_READ_TOKEN" \
     "$FIXPROMPT_BROKER_URL/projects/$FIXPROMPT_SERVER_PROJECT_ID/logs?since=24h&level=error,warn,fatal&limit=200"
   ```

2. **Parse `entries[]`** — `ts`, `level`, `message`, `attrs`, `stack`. Find matches. Cite specific lines.

3. **Apply a fix** grounded in what the logs show. **Do not ask the user to paste log lines — fetch them yourself.**

4. **Verify locally** — run the build / dev server / tests so the fix compiles and the affected path no longer throws.

5. **Re-fetch with `since=5m`** after deploy. If errors persist or new ones appear → **loop back to step 1.** Stop when the query is clean for the user's symptom.

### Projects

- **hiringflow-frontend** — https://fixloop-dashboard.vercel.app/issues/6e6c64da-743e-4fee-ae13-7ce079f60319
- **hiringflow** — https://fixloop-dashboard.vercel.app/issues/82bb4d8f-d560-489e-8b10-9df78519bba4
