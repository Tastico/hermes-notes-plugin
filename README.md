# Notes: a Nextcloud Notes tab for Hermes Desktop

Read, write and search your Nextcloud Notes from inside Hermes. Notes stay plain
markdown files under `/Notes` in your Nextcloud account, so the Notes web app,
the phone app and Hermes all edit the same content.

- A `/notes` page plus a sidebar row in Hermes Desktop (and in the browser Webapp).
- Note list with search, category filter, favourite marker and excerpt.
- Editor with per-note unsaved drafts (switching notes never loses an edit),
  explicit Save and `Ctrl/Cmd+S`.
- Save conflicts are refused, not overwritten: the backend compares the mtime the
  edit started from and answers `409` when someone wrote in between.
- Credentials stay on the backend. The renderer only talks to `/api/plugins/notes`.

## Requirements

- Hermes Agent `>= 0.22.6` (desktop plugin SDK and the `/api/plugins/<name>/` REST door).
- A Nextcloud instance with the **Notes** app enabled (`occ app:install notes`).
- One app password for the account that owns the notes.

## Install

1. Copy this directory to `~/.hermes/plugins/notes` (Windows: the Hermes home the
   app uses, the folder holding `config.yaml`, for example
   `%LOCALAPPDATA%\hermes\plugins\notes`).

   ```bash
   git clone <this repo> ~/.hermes/plugins/notes
   ```

2. Enable the plugin so its backend may be imported:

   ```bash
   hermes plugins enable notes
   ```

3. Create an app password in Nextcloud (Settings, Security, "Create app
   password", or `occ user:auth-tokens:add --name hermes-notes <user>`) and store
   it where only you can read it:

   ```bash
   install -m 600 /dev/null ~/.hermes/credentials/nextcloud-notes-app-password.txt
   printf '%s' 'THE-APP-PASSWORD' > ~/.hermes/credentials/nextcloud-notes-app-password.txt
   ```

4. Point the backend at your server, with environment variables or with
   `~/.hermes/notes-config.json`:

   ```json
   {
     "url": "https://cloud.example.com",
     "user": "your-login",
     "insecure_tls": false
   }
   ```

5. Make the UI load. The desktop app reads plugins from its own disk: the
   app-level door is `<hermes home>/desktop-plugins/notes/plugin.js`, and the app
   copies `plugins/notes/desktop/plugin.js` there on start. Restart the app once
   after installing.

6. Check the backend is mounted:

   ```bash
   curl -s -H "X-Hermes-Session-Token: $TOKEN" http://127.0.0.1:9119/api/plugins/notes/status
   # {"ok":true,"base_url":"...","user":"...","note_count":42,"latency_ms":90}
   ```

   The dashboard hot-mounts the router on the first request, so enabling the
   plugin needs no dashboard restart.

## Configuration reference

| Setting | Environment | `notes-config.json` | Default |
|---|---|---|---|
| Base URL | `NC_NOTES_URL` | `url` | `http://localhost:8082` |
| Login | `NC_NOTES_USER` | `user` | none (the endpoint answers 503) |
| App password | `NC_NOTES_TOKEN` | `token_file` (a path) | `~/.hermes/credentials/nextcloud-notes-app-password.txt` |
| Self-signed TLS | | `insecure_tls: true` | off |

## API (mounted at `/api/plugins/notes`)

| Route | Purpose |
|---|---|
| `GET /status` | Reachability, note count, latency |
| `GET /notes?q=&category=` | Summaries, newest first |
| `GET /notes/{id}` | Full note with content |
| `POST /notes` | Create (`title`, `content`, `category`) |
| `PUT /notes/{id}` | Update; `modified` guards against clobbering |
| `DELETE /notes/{id}` | Delete |

## Security notes

- The app password is read by the backend only (`NC_NOTES_TOKEN` or a file). It is
  never sent to the renderer and never logged.
- The plugin's REST namespace is scoped by construction: `ctx.rest('/notes')`
  resolves to `/api/plugins/notes/notes`, behind the dashboard's own auth gate.
- `desktop/plugin.js` imports only `@hermes/plugin-sdk` and `react`; the runtime
  loader refuses anything else, and `tools/check` runs the same admission lint
  Hermes uses (`hermes_cli/plugin_validate_desktop.py`) plus an ESM parse.
- Deleting a note in the tab deletes the file in Nextcloud. There is no undo in
  this plugin.

## Layout

```
plugin.yaml                 plugin metadata and optional env docs
dashboard/manifest.json     declares the backend router to the dashboard
dashboard/plugin_api.py     the Notes API proxy (FastAPI router)
desktop/plugin.js           the /notes page: plain ESM, no build step
tools/check                 the repo gate (python compile, desktop lint, ESM parse)
```

## License

MIT. See `LICENSE`.
