# Personal Coder Tool

Standalone local coding agent using your own API key/base URL.

## Features

- Chat-based coding workflow with saving mode
- Mode-based model routing (Haiku default, Sonnet for complex plan/debug)
- Tools: `list_files`, `read_file`, `write_file`, `search_code`, `run_command`, git tools, `deploy_gcp`
- Approval with preview for writes + auto-continue agent after approval
- Quick actions: Git Status, Git Diff, Project Tree
- API retry on transient failures
- Project context auto-loaded from `package.json` / `README.md`
- Token usage shown per response

## Setup

1. Copy `.env.example` to `.env`
2. Fill:
   - `API_BASE_URL`
   - `API_KEY`
   - `WORKSPACE_DIR` (project to operate on)
3. Install and run:

```bash
npm install
npm run dev
```

4. Open `http://localhost:8787`

## Saving mode (important for low budget)

With `SAVE_MODE=true` (default):

- `hi`, `hello`, `thanks` etc. -> **no API call** (free local reply)
- **Code mode** -> Haiku with low token cap
- **Plan/Debug mode** -> Haiku unless message looks complex (architecture, deploy, errors)
- Sonnet only when complex OR you check **Force Sonnet** in UI

### Budget workflow for finishing your app + GCP deploy

1. Point `WORKSPACE_DIR` to your real app repo (e.g. `claude-leadnest`).
2. Use **Code** mode for feature implementation (cheapest).
3. Use **Plan** only for architecture decisions (auto-uses Sonnet only when needed).
4. Use **Debug** + Force Sonnet only when something is broken in production.
5. Approve `git commit` / `git push` / deploy commands manually.
6. After push, GCP/Vercel auto-deploy handles visibility (if CI is already connected).

## Notes

- This is intended for personal/local use.
- No login/auth is included.
- Keep approval flow enabled for safety.
