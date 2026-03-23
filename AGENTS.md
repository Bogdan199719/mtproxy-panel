# Repository Guidelines

## Project Structure & Module Organization
`backend/src/` contains the Node.js API and background jobs: `app.js` for Express routes, `db.js` for SQLite schema access, `ssh.js` for node orchestration, and `totp.js` for 2FA. `public/index.html` serves the SPA shell and client-side UI. `mtg-agent/` holds the Python FastAPI agent deployed to managed nodes. Runtime data lives in `data/` and local SSH material in `ssh_keys/`. Deployment files are at the repo root: `Dockerfile`, `docker-compose.yml`, `install.sh`, `update.sh`, and `uninstall.sh`.

## Build, Test, and Development Commands
Run backend code from `backend/`:

- `npm install` installs API dependencies.
- `npm run dev` starts the API with `nodemon` for local edits.
- `npm start` runs the production backend entrypoint.

Run the full panel from the repository root:

- `docker compose up -d --build` builds the image, precompiles JSX via `build-jsx.js`, and starts the panel.
- `docker compose down` stops local services.
- `bash update.sh` applies the repo update flow on deployed hosts.

## Coding Style & Naming Conventions
Follow the existing style in each language. JavaScript uses CommonJS, semicolons, mostly single quotes, and aligned `const` declarations where readability benefits. Keep route handlers and SQL changes explicit rather than abstracting prematurely. Python in `mtg-agent/` follows PEP 8 with 4-space indentation and snake_case names. Name new API files by responsibility (`billing.js`, `metrics.js`) and keep environment variables uppercase, matching `.env.example`.

## Testing Guidelines
There is no formal test suite or lint configuration yet. For backend changes, validate manually with `npm start` or `docker compose up -d --build`, then hit key endpoints such as `/api/health`, `/api/version`, and the route you changed. For agent changes, verify `mtg-agent/main.py` responses from `/health` and `/metrics`. Include clear reproduction and verification steps in the PR when automated coverage is absent.

## Commit & Pull Request Guidelines
Recent history follows Conventional Commits: `feat:`, `fix:`, `docs:`, `chore:`, and `release:`. Keep commit subjects imperative and scoped to one change, for example `fix: validate renew days input`. PRs should include a short summary, deployment impact, related issue or task link, environment changes, and screenshots for UI changes. Call out any database migration, new env var, or API contract change explicitly.

## Security & Configuration Tips
Do not commit populated `.env`, database files, or private SSH keys. Keep changes to auth, tokens, CORS, and shell/SSH execution paths minimal and reviewable. When adding config, update `.env.example` and document sane defaults.
