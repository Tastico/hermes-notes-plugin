# Changelog

All notable changes to this plugin. Versions follow the `version` field in
`plugin.yaml`, which is what Hermes shows in Capabilities, Plugins.

## 1.2.0

- Surfaces now follow the active theme. The page used to paint `var(--ui-bg-primary)`
  and `var(--ui-bg-input)`; Hermes' light ramp hard-codes `--ui-bg-input` to
  `#fcfcfc`, so the tab read as a flat white sheet under any user palette.
  Backgrounds are now translucent mixes of `--ui-text-primary` over the host
  background, and the pane itself paints nothing.
- Added a side-rail pane: `Side pane` in the editor footer pins the open note to
  the right rail beside the chat, the way the terminal docks. The rail has its
  own note picker, title, editor and Save.
- Rail edits track their own baseline, so Save is enabled only for real changes.

## 1.1.0

- Configuration moved out of the code: `NC_NOTES_URL`, `NC_NOTES_USER`,
  `NC_NOTES_TOKEN`, then `~/.hermes/notes-config.json`, then a loopback default.
  No server address or account name ships in the repo.
- `token_file` and `insecure_tls` options for self-signed instances and for
  keeping the app password somewhere other than the default credentials file.
- `register()` in the Python package so the plugin passes the loader's
  capability probe.
- The repo gate dropped its import of a private Hermes module, so it runs with
  stdlib and node alone. The admission lint is a documented manual step.

## 1.0.0

- First release: a `/notes` page (list, search, category filter, editor with
  per-note drafts, favourites, delete), a sidebar row, and a backend proxy to the
  Nextcloud Notes REST API with a `409` conflict guard on saves.
- Manifest declares the backend router only (`tab.hidden`), so the browser
  dashboard adds no extra nav row.
