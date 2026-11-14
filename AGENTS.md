# AGENTS.md: hermes-notes-plugin

A Hermes plugin that puts a Nextcloud Notes tab in Hermes Desktop. Two halves:
`desktop/plugin.js` (the UI, loaded by the app's plugin loader) and
`dashboard/plugin_api.py` (a FastAPI router the dashboard mounts at
`/api/plugins/notes`). Detail lives in `README.md`; this file is the map.

## Map

| Path | What it is | Change it when |
|---|---|---|
| `plugin.yaml` | plugin metadata, optional env docs | adding a config knob |
| `dashboard/manifest.json` | tells the dashboard this plugin has a backend (`api`) | renaming the router file |
| `dashboard/plugin_api.py` | the Notes API proxy, config resolution, error mapping | talking to Nextcloud differently |
| `desktop/plugin.js` | the `/notes` page: sidebar row plus editor | any UI change |
| `tools/check`, `tools/check.py` | the gate | extending what is validated |
| `.github/workflows/check.yml` | CI runs the same gate | never, unless CI itself changes |

## Hard rules

- **One gate.** `tools/check` is the only check; it runs in the pre-commit hook,
  in CI, and before a release. A finding count may fall, never rise: fix the
  finding, do not relax the check.
- **`desktop/plugin.js` imports only `@hermes/plugin-sdk` and `react*`.** The
  app's runtime loader refuses any other specifier, and `eval`/`new Function`
  and URL-scheme imports are refused with it.
- **No app-DOM reach.** Never `document.querySelector('[data-slot…]')` or observe
  `document.body`; extend through a slot, route or SDK hook. The Hermes
  admission lint fails these.
- **Credentials never leave the backend.** No password, token or URL with a
  secret in `desktop/plugin.js`, in logs, or in an error body. Config is read per
  request from env, then `~/.hermes/notes-config.json`.
- **Writes are conflict-safe.** The client sends the `modified` it edited from; a
  newer server copy answers `409` instead of clobbering. Do not remove that.
- **House style:** no em or en dashes anywhere (the gate fails them), plain
  sentences, no marketing adjectives.
- Keep the UI dependency-free. No build step, no bundles, no CSS framework: the
  file is evaluated as-is.

## Verify before claiming done

```bash
tools/check                                   # structure, import allowlist, dashes, ESM parse
hermes plugins enable notes                   # the backend may only be imported when enabled
curl -s -H "X-Hermes-Session-Token: $TOKEN" http://127.0.0.1:9119/api/plugins/notes/status
```

Release review only: Hermes' own admission lint (needs a hermes-agent checkout)
is a stronger form of the import check. It is deliberately not wired into the
gate, because importing it would tie the gate to a private module. Command in
README, section Development.

A `200` from `/status` with a real `note_count` is the backend proof. The UI
proof is the tab opening in a real app window; the gate cannot see rendering.

## Layout of a change

1. Edit, run `tools/check`.
2. Prove the behaviour against a real Nextcloud: create, read, edit, delete a
   note through `/api/plugins/notes/...`.
3. Bump `version` in `plugin.yaml` for a UI or API change; the desktop app keeps
   a copy of `desktop/plugin.js` and re-copies it when the source changes.
