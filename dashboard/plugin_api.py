"""Notes: Nextcloud Notes backend for the Hermes Notes tab.

Mounted by the dashboard at ``/api/plugins/notes/``. Every handler is a thin
proxy over the Nextcloud Notes REST API (app ``notes``, v1), so the desktop tab
and the Nextcloud Notes web app can never drift: both write the same files under
``/Notes`` in the account's Files.

Credentials never reach the renderer. The app password lives in
``~/.hermes/credentials/nextcloud-notes-app-password.txt`` (0600), or in
``NC_NOTES_TOKEN``; the base URL and user come from ``NC_NOTES_URL`` /
``NC_NOTES_USER`` with the LAN default below.

Why a proxy and not a direct browser call: the renderer runs with Electron
``webSecurity`` on and no Nextcloud session cookie, and the public hostname sits
behind the tstc SSO. The dashboard reaches Nextcloud on the LAN by IP.
"""

from __future__ import annotations

import asyncio
import base64
import json
import os
import ssl
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

router = APIRouter()

DEFAULT_URL = "http://localhost:8082"
DEFAULT_TOKEN_FILE = Path.home() / ".hermes" / "credentials" / "nextcloud-notes-app-password.txt"
CONFIG_FILE = Path.home() / ".hermes" / "notes-config.json"
NOTES_API = "/index.php/apps/notes/api/v1"
TIMEOUT_SECONDS = 12


# --- config -----------------------------------------------------------------
#
# Resolution order per request: environment, then ~/.hermes/notes-config.json,
# then the defaults below. Nothing secret is shipped in this file, and nothing
# secret is ever returned to the client.


def _config() -> dict:
    try:
        data = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def _base_url() -> str:
    env = os.environ.get("NC_NOTES_URL")
    return (env or _config().get("url") or DEFAULT_URL).rstrip("/")


def _user() -> str:
    user = os.environ.get("NC_NOTES_USER") or _config().get("user")
    if not user:
        raise HTTPException(
            status_code=503,
            detail=(
                "No Nextcloud user configured. Set NC_NOTES_USER, or write "
                f'{{"url": "...", "user": "..."}} to {CONFIG_FILE}'
            ),
        )
    return str(user)


def _token_file() -> Path:
    configured = _config().get("token_file")
    return Path(str(configured)).expanduser() if configured else DEFAULT_TOKEN_FILE


def _token() -> str:
    env = os.environ.get("NC_NOTES_TOKEN")
    if env and env.strip():
        return env.strip()
    path = _token_file()
    try:
        token = path.read_text(encoding="utf-8").strip()
    except OSError as exc:
        raise HTTPException(
            status_code=503,
            detail=(
                f"Nextcloud app password unavailable ({exc.__class__.__name__}); "
                f"write it to {path}, set token_file in {CONFIG_FILE}, or set NC_NOTES_TOKEN"
            ),
        ) from exc
    if not token:
        raise HTTPException(status_code=503, detail=f"Nextcloud app password file is empty: {path}")
    return token


def _opener() -> urllib.request.OpenerDirector:
    if _config().get("insecure_tls"):
        context = ssl.create_default_context()
        context.check_hostname = False
        context.verify_mode = ssl.CERT_NONE
        return urllib.request.build_opener(urllib.request.HTTPSHandler(context=context))
    return urllib.request.build_opener()


# --- transport --------------------------------------------------------------


def _sync_call(method: str, path: str, payload: Optional[dict] = None) -> Any:
    """One blocking Notes API call. Returns the decoded JSON body."""
    url = f"{_base_url()}{NOTES_API}{path}"
    auth = base64.b64encode(f"{_user()}:{_token()}".encode()).decode()
    headers = {
        "Authorization": f"Basic {auth}",
        "OCS-APIRequest": "true",
        "Accept": "application/json",
        "User-Agent": "hermes-notes-plugin/1.0",
    }
    body: Optional[bytes] = None
    if payload is not None:
        body = json.dumps(payload).encode()
        headers["Content-Type"] = "application/json"

    request = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with _opener().open(request, timeout=TIMEOUT_SECONDS) as response:
            raw = response.read()
    except urllib.error.HTTPError as exc:
        detail = _error_detail(exc)
        if exc.code == 404:
            raise HTTPException(status_code=404, detail=detail) from exc
        if exc.code in (401, 403):
            raise HTTPException(
                status_code=502,
                detail=f"Nextcloud refused the app password ({exc.code}): {detail}",
            ) from exc
        if exc.code == 409:
            raise HTTPException(
                status_code=409,
                detail=f"Note changed on the server since it was opened: {detail}",
            ) from exc
        raise HTTPException(status_code=502, detail=f"Nextcloud answered {exc.code}: {detail}") from exc
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise HTTPException(
            status_code=502,
            detail=f"Nextcloud unreachable at {_base_url()} ({exc.__class__.__name__})",
        ) from exc

    if not raw:
        return None
    try:
        return json.loads(raw)
    except ValueError:
        return raw.decode("utf-8", "replace")


def _error_detail(exc: urllib.error.HTTPError) -> str:
    try:
        raw = exc.read().decode("utf-8", "replace")
    except Exception:  # health: allow BLE001 -- a body we cannot read still yields the status line
        return exc.reason or "no detail"
    try:
        parsed = json.loads(raw)
    except ValueError:
        return raw[:300] or (exc.reason or "no detail")
    if isinstance(parsed, dict):
        for key in ("errorMessage", "message", "error", "detail"):
            value = parsed.get(key)
            if isinstance(value, str) and value:
                return value[:300]
    return raw[:300]


async def _call(method: str, path: str, payload: Optional[dict] = None) -> Any:
    return await asyncio.to_thread(_sync_call, method, path, payload)


def _note_id_or_400(note_id: str) -> str:
    text = str(note_id).strip()
    if not text.isdigit():
        raise HTTPException(status_code=400, detail=f"note id must be numeric, got {text!r}")
    return text


def _excerpt(content: str, limit: int = 180) -> str:
    lines = []
    for line in (content or "").splitlines():
        stripped = line.strip().lstrip("#").strip()
        if stripped:
            lines.append(stripped)
        if sum(len(part) + 1 for part in lines) > limit:
            break
    text = " ".join(lines)
    return text[:limit]


def _summary(note: dict, excerpt_limit: int = 180) -> dict:
    return {
        "id": note.get("id"),
        "title": note.get("title") or "Untitled",
        "category": note.get("category") or "",
        "favorite": bool(note.get("favorite")),
        "modified": note.get("modified"),
        "etag": note.get("etag"),
        "readonly": bool(note.get("readonly")),
        "excerpt": _excerpt(note.get("content") or "", excerpt_limit),
    }


# --- models -----------------------------------------------------------------


class NoteCreate(BaseModel):
    title: Optional[str] = Field(None, description="First line / title")
    content: Optional[str] = Field(None, description="Markdown body")
    category: Optional[str] = Field(None, description="Folder under /Notes")


class NoteUpdate(BaseModel):
    title: Optional[str] = None
    content: Optional[str] = None
    category: Optional[str] = None
    favorite: Optional[bool] = None
    modified: Optional[int] = Field(
        None, description="Last known mtime for conflict detection (optional)"
    )


# --- routes -----------------------------------------------------------------


@router.get("/status")
async def status() -> dict:
    started = time.monotonic()
    notes = await _call("GET", "/notes")
    if not isinstance(notes, list):
        raise HTTPException(status_code=502, detail="Unexpected Notes API payload")
    return {
        "ok": True,
        "base_url": _base_url(),
        "user": _user(),
        "note_count": len(notes),
        "latency_ms": int((time.monotonic() - started) * 1000),
    }


@router.get("/notes")
async def list_notes(
    category: Optional[str] = Query(None, description="Exact category filter"),
    q: Optional[str] = Query(None, description="Substring match on title or body"),
) -> dict:
    notes = await _call("GET", "/notes")
    if not isinstance(notes, list):
        raise HTTPException(status_code=502, detail="Unexpected Notes API payload")
    rows = [_summary(note) for note in notes if isinstance(note, dict)]
    if category:
        rows = [row for row in rows if row["category"] == category]
    if q:
        needle = q.strip().lower()
        # Body text is not in the summary; filter on what /notes already carries.
        bodies = {
            note.get("id"): (note.get("content") or "").lower()
            for note in notes
            if isinstance(note, dict)
        }
        rows = [
            row
            for row in rows
            if needle in str(row["title"]).lower() or needle in bodies.get(row["id"], "")
        ]
    rows.sort(key=lambda row: row.get("modified") or 0, reverse=True)
    categories = sorted({row["category"] for row in rows if row["category"]})
    return {"notes": rows, "count": len(rows), "categories": categories}


@router.get("/notes/{note_id}")
async def get_note(note_id: str) -> dict:
    note = await _call("GET", f"/notes/{_note_id_or_400(note_id)}")
    if not isinstance(note, dict):
        raise HTTPException(status_code=502, detail="Unexpected Notes API payload")
    return note


@router.post("/notes")
async def create_note(payload: NoteCreate) -> dict:
    body: dict = {}
    if payload.content is not None:
        body["content"] = payload.content
    if payload.title is not None:
        body["title"] = payload.title
    if payload.category is not None:
        body["category"] = payload.category
    if not body:
        raise HTTPException(status_code=400, detail="title, content or category is required")
    note = await _call("POST", "/notes", body)
    if not isinstance(note, dict):
        raise HTTPException(status_code=502, detail="Unexpected Notes API payload")
    return note


@router.put("/notes/{note_id}")
async def update_note(note_id: str, payload: NoteUpdate) -> dict:
    note_id = _note_id_or_400(note_id)
    current = await _call("GET", f"/notes/{note_id}")
    if not isinstance(current, dict):
        raise HTTPException(status_code=502, detail="Unexpected Notes API payload")
    if current.get("readonly"):
        raise HTTPException(status_code=409, detail="Note is readonly on the server")

    # The Notes API treats an update as a full write of the fields it is given,
    # so start from the server copy and overlay only what the client changed.
    body: dict = {
        "content": current.get("content") or "",
        "title": current.get("title") or "",
        "category": current.get("category") or "",
        "favorite": bool(current.get("favorite")),
        "modified": current.get("modified"),
    }
    if payload.content is not None:
        body["content"] = payload.content
    if payload.title is not None:
        body["title"] = payload.title
    if payload.category is not None:
        body["category"] = payload.category
    if payload.favorite is not None:
        body["favorite"] = payload.favorite
    # Conflict guard: the client sends the mtime it edited from; a newer server
    # copy means someone else wrote in between, and we refuse rather than clobber.
    if payload.modified is not None and current.get("modified") not in (None, payload.modified):
        raise HTTPException(
            status_code=409,
            detail="Note changed on the server since it was opened; reload before saving",
        )
    note = await _call("PUT", f"/notes/{note_id}", body)
    if not isinstance(note, dict):
        raise HTTPException(status_code=502, detail="Unexpected Notes API payload")
    return note


@router.delete("/notes/{note_id}")
async def delete_note(note_id: str) -> dict:
    note_id = _note_id_or_400(note_id)
    await _call("DELETE", f"/notes/{note_id}")
    return {"ok": True, "id": int(note_id)}
