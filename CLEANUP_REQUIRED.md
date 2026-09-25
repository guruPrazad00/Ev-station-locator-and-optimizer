# CLEANUP_REQUIRED.md

Review performed after the P1–P11 pass (backend, frontend, styles, env, docs).
Rule applied: delete only confirmed-unused items; list everything uncertain here.
`package.json`, `package-lock.json`, `.env.example`, and all working
backend/frontend files are intact. `node_modules/` and `.env` are git-ignored
and must not be packaged.

## Removed during this pass (safe, completed)

- Unused `ocmConfigured` export in `backend/services/liveSources.js`
  (OCM key check lives inside `getLiveStations`).
- Stray `link` CSS class on the "Open in Maps" anchor in `app.js` (no such rule).
- Temp probe scripts in `%LOCALAPPDATA%\Temp\opencode\` (deleted).
- Earlier: dead `mergeWithCurated` helper and dead `req.logHint` assignment.

## Anything you can safely delete manually

- `src/` — empty directory, never imported or served. Safe to delete.
- `SYSTEM_DESIGN.md` — earlier prototype design reference, not referenced by code.
  Keep for context or delete; your call.
- `GET /api/config` endpoint — informational only, frontend does not consume it yet.
  Keep (harmless) or remove for zero dead surface.
- `source` / `live` query params on `/api/stations/nearby` — power-user/debugging
  surface. Keep (documented, tested) or remove for the narrowest API.
- `GET /api/stations` root alias — thin convenience alias of search.

## Deliberately NOT deleted (uncertain — your decision)

- `GET /api/stations` root alias (see above).
- `.git/` — keep in development; exclude only from a submission ZIP if appropriate.
- Repo has no commits yet (`master` unborn); consider an initial commit after review.

## Dependency audit result

No unused npm dependencies — `express`, `cors`, `dotenv`,
`express-rate-limit`, `morgan` are all imported and exercised.
No dependencies added or removed. No unused files/imports/functions remain
in `backend/`, `app.js`, `index.html`, or `styles.css` (verified by reference grep).
