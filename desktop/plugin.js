/**
 * Notes: a Nextcloud Notes tab for Hermes Desktop.
 *
 * A full page at /notes plus a sidebar row and a dirty-aware editor. All data
 * goes through `ctx.rest` to this plugin's own backend (`dashboard/plugin_api.py`
 * at /api/plugins/notes), which holds the Nextcloud app password and proxies the
 * Notes REST API. Nothing secret is in this file, and the renderer never talks to
 * Nextcloud directly.
 *
 * Edits stay local (per note, so switching notes never loses a draft) until Save
 * or Ctrl/Cmd+S. A save that loses a race with another writer is refused by the
 * backend (409) and surfaced as a reload prompt instead of a silent overwrite.
 */

import { host, ROUTES_AREA, SIDEBAR_NAV_AREA } from '@hermes/plugin-sdk'
import { createElement as h, useCallback, useEffect, useMemo, useRef, useState } from 'react'

const PAGE_PATH = '/notes'
const SELECTED_KEY = 'notes.selectedId'
const POLL_MS = 90_000

let stylesInjected = false

function ensureStyles() {
  if (stylesInjected || typeof document === 'undefined') {
    return
  }
  stylesInjected = true
  const el = document.createElement('style')
  el.setAttribute('data-notes-plugin', '1')
  el.textContent = `
    .nc-page { display: flex; flex-direction: column; height: 100%; min-height: 0;
      color: var(--ui-text-primary); background: transparent; font-size: 13px; }
    .nc-bar { display: flex; align-items: center; gap: 8px; flex: 0 0 auto;
      padding: 8px 12px; border-bottom: 1px solid var(--ui-stroke-secondary);
      background: transparent; }
    .nc-bar__title { font-size: 13px; font-weight: 650; letter-spacing: 0.01em; }
    .nc-chip { font-size: 11px; color: var(--ui-text-tertiary);
      border: 1px solid var(--ui-stroke-secondary); border-radius: 999px; padding: 1px 8px; }
    .nc-search { flex: 1 1 auto; min-width: 120px; max-width: 420px; }
    .nc-input, .nc-select { background: color-mix(in srgb, var(--ui-text-primary) 6%, transparent);
      color: inherit; border: 1px solid var(--ui-stroke-secondary); border-radius: 6px;
      padding: 4px 8px; font-size: 12px; font-family: inherit; outline: none; }
    .nc-input:focus, .nc-select:focus { border-color: var(--ui-accent); }
    .nc-btn { display: inline-flex; align-items: center; gap: 5px; cursor: pointer;
      background: transparent; color: var(--ui-text-primary);
      border: 1px solid var(--ui-stroke-secondary); border-radius: 6px;
      padding: 4px 10px; font-size: 12px; font-family: inherit; }
    .nc-btn:hover { background: color-mix(in srgb, var(--ui-text-primary) 8%, transparent); }
    .nc-btn:disabled { opacity: 0.45; cursor: default; }
    .nc-btn--primary { background: var(--ui-accent); color: var(--ui-accent-foreground, #fff);
      border-color: transparent; font-weight: 600; }
    .nc-btn--danger:hover { border-color: var(--ui-red); color: var(--ui-red); }
    .nc-body { display: flex; flex: 1 1 auto; min-height: 0; }
    .nc-list { display: flex; flex-direction: column; width: 304px; min-width: 200px;
      min-height: 0; border-right: 1px solid var(--ui-stroke-secondary);
      background: color-mix(in srgb, var(--ui-text-primary) 4%, transparent); }
    .nc-list__scroll { flex: 1 1 auto; overflow-y: auto; min-height: 0; }
    .nc-row { display: block; width: 100%; text-align: left; cursor: pointer;
      border: 0; border-bottom: 1px solid var(--ui-stroke-secondary);
      background: transparent; color: inherit; font-family: inherit; padding: 8px 10px 7px; }
    .nc-row:hover { background: color-mix(in srgb, var(--ui-text-primary) 7%, transparent); }
    .nc-row--active { background: color-mix(in srgb, var(--ui-text-primary) 10%, transparent);
      box-shadow: inset 2px 0 0 var(--ui-accent); }
    .nc-row__head { display: flex; align-items: baseline; gap: 6px; }
    .nc-row__title { flex: 1 1 auto; font-size: 12.5px; font-weight: 600;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .nc-row__excerpt { margin-top: 2px; font-size: 11.5px; line-height: 1.45;
      color: var(--ui-text-tertiary); display: -webkit-box; -webkit-line-clamp: 2;
      -webkit-box-orient: vertical; overflow: hidden; }
    .nc-row__foot { display: flex; align-items: center; gap: 6px; margin-top: 4px;
      font-size: 10.5px; color: var(--ui-text-tertiary); }
    .nc-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--ui-accent);
      flex: 0 0 auto; }
    .nc-tag { border: 1px solid var(--ui-stroke-secondary); border-radius: 4px;
      padding: 0 4px; font-size: 10px; }
    .nc-editor { display: flex; flex: 1 1 auto; flex-direction: column; min-width: 0;
      min-height: 0; background: transparent; }
    .nc-editor__head { display: flex; align-items: center; gap: 8px; flex: 0 0 auto;
      padding: 10px 14px 6px; }
    .nc-title-input { flex: 1 1 auto; min-width: 0; background: transparent;
      border: 0; outline: none; color: inherit; font-family: inherit;
      font-size: 16px; font-weight: 650; padding: 2px 0; }
    .nc-meta { display: flex; align-items: center; gap: 8px; flex: 0 0 auto;
      padding: 0 14px 8px; font-size: 11px; color: var(--ui-text-tertiary); }
    .nc-body-input { flex: 1 1 auto; min-height: 0; resize: none; border: 0; outline: none;
      background: transparent; color: inherit; font-family: inherit;
      font-size: 13px; line-height: 1.65; padding: 4px 14px 14px; }
    .nc-foot { display: flex; align-items: center; gap: 8px; flex: 0 0 auto;
      padding: 7px 14px; border-top: 1px solid var(--ui-stroke-secondary);
      background: transparent; font-size: 11px; color: var(--ui-text-tertiary); }
    .nc-foot__spacer { flex: 1 1 auto; }
    .nc-hint { color: var(--ui-text-tertiary); font-size: 11px; }
    .nc-empty { flex: 1 1 auto; display: flex; flex-direction: column; align-items: center;
      justify-content: center; gap: 6px; color: var(--ui-text-tertiary); font-size: 12px; }
    .nc-error { margin: 8px 14px; padding: 7px 10px; border-radius: 6px; font-size: 12px;
      color: var(--ui-red); border: 1px solid var(--ui-red);
      background: color-mix(in srgb, var(--ui-red) 10%, transparent); }
    .nc-star { border: 0; background: transparent; cursor: pointer; font-size: 13px;
      line-height: 1; padding: 2px; color: var(--ui-text-tertiary); }
    .nc-star--on { color: var(--ui-orange); }
    /* The side-rail pane: same tokens, tighter spacing. */
    .nc-rail { display: flex; flex-direction: column; height: 100%; min-height: 0;
      background: transparent; color: var(--ui-text-primary); font-size: 12.5px; }
    .nc-rail__head { display: flex; align-items: center; gap: 6px; padding: 8px 10px;
      border-bottom: 1px solid var(--ui-stroke-secondary); flex: 0 0 auto; }
    .nc-rail__title { flex: 1 1 auto; min-width: 0; background: transparent; border: 0;
      outline: none; color: inherit; font-family: inherit; font-size: 13px; font-weight: 600; }
    .nc-rail__body { flex: 1 1 auto; min-height: 0; resize: none; border: 0; outline: none;
      background: transparent; color: inherit; font-family: inherit; font-size: 12.5px;
      line-height: 1.6; padding: 8px 10px; }
    .nc-rail__foot { display: flex; align-items: center; gap: 6px; padding: 6px 10px;
      border-top: 1px solid var(--ui-stroke-secondary); font-size: 11px;
      color: var(--ui-text-tertiary); flex: 0 0 auto; }
    .nc-rail__spacer { flex: 1 1 auto; }
  `
  document.head.appendChild(el)
}

function signature(value) {
  return [value.title || '', value.content || '', value.category || '', value.favorite ? 1 : 0].join('\u0001')
}

function relTime(seconds) {
  if (!seconds) {
    return ''
  }
  const delta = Date.now() / 1000 - seconds
  if (delta < 60) {
    return 'just now'
  }
  if (delta < 3600) {
    return `${Math.floor(delta / 60)}m ago`
  }
  if (delta < 86400) {
    return `${Math.floor(delta / 3600)}h ago`
  }
  if (delta < 604800) {
    return `${Math.floor(delta / 86400)}d ago`
  }
  return new Date(seconds * 1000).toLocaleDateString()
}

function clockTime(seconds) {
  return seconds ? new Date(seconds * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''
}

function errorText(error) {
  const message = error && error.message ? String(error.message) : String(error || 'unknown error')
  return message.length > 240 ? `${message.slice(0, 240)}…` : message
}

// --- side-rail pane ---------------------------------------------------------
// One note, docked beside the chat like the terminal pane. The pane is a
// `panes` contribution at placement 'right'; its contribution-scoped id is
// `<pluginId>:<paneId>` = 'notes:rail', which is what host.revealPane takes.

const RAIL_PANE_ID = 'notes:rail'

const railState = { id: null, listeners: new Set() }

function setRailNote(id) {
  railState.id = id
  for (const listener of railState.listeners) {
    listener(id)
  }
}

function useRailNote() {
  const [value, setValue] = useState(railState.id)
  useEffect(() => {
    const listener = next => setValue(next)
    railState.listeners.add(listener)
    return () => railState.listeners.delete(listener)
  }, [])
  return value
}

function showRail(id) {
  if (id != null) {
    setRailNote(id)
  }
  try {
    host.undismissPane?.(RAIL_PANE_ID)
    host.revealPane?.(RAIL_PANE_ID)
  } catch {
    /* older desktop: the pane is still opened from the rail's own tab list */
  }
}

function NoteRail({ ctx }) {
  ensureStyles()
  const railId = useRailNote()
  const [rows, setRows] = useState([])
  const [draft, setDraft] = useState(null)
  const [state, setState] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    let alive = true
    ctx
      .rest('/notes')
      .then(data => {
        if (alive) {
          setRows(Array.isArray(data.notes) ? data.notes : [])
        }
      })
      .catch(err => {
        if (alive) {
          setError(errorText(err))
        }
      })
    return () => {
      alive = false
    }
  }, [ctx])

  useEffect(() => {
    if (!railId) {
      setDraft(null)
      return undefined
    }
    let alive = true
    setError('')
    setState('')
    ctx
      .rest(`/notes/${railId}`)
      .then(note => {
        if (alive) {
          const value = {
            id: note.id,
            title: note.title || '',
            content: note.content || '',
            modified: note.modified,
            readonly: Boolean(note.readonly),
            base: ''
          }
          value.base = signature(value)
          setDraft(value)
        }
      })
      .catch(err => {
        if (alive) {
          setError(errorText(err))
        }
      })
    return () => {
      alive = false
    }
  }, [ctx, railId])

  const dirty = Boolean(draft) && signature(draft) !== draft.base

  const save = async () => {
    if (!draft || draft.readonly) {
      return
    }
    setState('saving')
    setError('')
    try {
      const note = await ctx.rest(`/notes/${draft.id}`, {
        method: 'PUT',
        body: { title: draft.title, content: draft.content, modified: draft.modified }
      })
      const value = {
        id: note.id,
        title: note.title || '',
        content: note.content || '',
        modified: note.modified,
        readonly: Boolean(note.readonly),
        base: ''
      }
      value.base = signature(value)
      setDraft(value)
      setState('saved')
    } catch (err) {
      setState('error')
      setError(errorText(err))
    }
  }

  return h(
    'div',
    { className: 'nc-rail' },
    h(
      'div',
      { className: 'nc-rail__head' },
      h(
        'select',
        {
          className: 'nc-select',
          style: { maxWidth: '150px' },
          value: draft ? draft.id : '',
          onChange: event => showRail(Number(event.target.value))
        },
        h('option', { value: '' }, 'Pick a note'),
        rows.map(row => h('option', { key: row.id, value: row.id }, row.title))
      ),
      h('input', {
        className: 'nc-rail__title',
        value: draft ? draft.title : '',
        placeholder: 'No note pinned',
        readOnly: !draft || draft.readonly,
        onChange: event => setDraft(current => (current ? { ...current, title: event.target.value } : current))
      })
    ),
    error ? h('div', { className: 'nc-error' }, error) : null,
    h('textarea', {
      className: 'nc-rail__body',
      value: draft ? draft.content : '',
      readOnly: !draft || draft.readonly,
      placeholder: 'Pin a note here from the Notes page.',
      onChange: event => setDraft(current => (current ? { ...current, content: event.target.value } : current))
    }),
    h(
      'div',
      { className: 'nc-rail__foot' },
      h('span', null, state === 'saving' ? 'Saving…' : dirty ? 'Unsaved' : draft ? relTime(draft.modified) : ''),
      h('span', { className: 'nc-rail__spacer' }),
      h('button', { type: 'button', className: 'nc-btn', onClick: () => host.navigate(PAGE_PATH) }, 'Notes'),
      h(
        'button',
        {
          type: 'button',
          className: 'nc-btn nc-btn--primary',
          disabled: !draft || !dirty || draft.readonly || state === 'saving',
          onClick: save
        },
        'Save'
      )
    )
  )
}

function NotesPage({ ctx }) {
  ensureStyles()

  const [rows, setRows] = useState([])
  const [categories, setCategories] = useState([])
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('')
  const [listError, setListError] = useState('')
  const [loadingList, setLoadingList] = useState(true)
  const [draft, setDraft] = useState(null)
  const [dirtyIds, setDirtyIds] = useState(() => new Set())
  const [saveState, setSaveState] = useState('')
  const [saveError, setSaveError] = useState('')

  const draftsRef = useRef(new Map())
  const filterRef = useRef({ query: '', category: '' })
  const selectedRef = useRef(null)

  const recomputeDirty = useCallback(() => {
    const next = new Set()
    for (const [id, value] of draftsRef.current.entries()) {
      if (signature(value) !== value.base) {
        next.add(id)
      }
    }
    setDirtyIds(next)
  }, [])

  const loadList = useCallback(
    async (nextQuery = filterRef.current.query, nextCategory = filterRef.current.category) => {
      const params = new URLSearchParams()
      if (nextQuery.trim()) {
        params.set('q', nextQuery.trim())
      }
      if (nextCategory) {
        params.set('category', nextCategory)
      }
      const suffix = params.toString() ? `/notes?${params.toString()}` : '/notes'
      try {
        const data = await ctx.rest(suffix)
        setRows(Array.isArray(data.notes) ? data.notes : [])
        if (Array.isArray(data.categories) && !nextCategory) {
          setCategories(data.categories)
        }
        setListError('')
      } catch (error) {
        setListError(errorText(error))
      } finally {
        setLoadingList(false)
      }
    },
    [ctx]
  )

  // First paint + debounced search + category filter.
  useEffect(() => {
    setLoadingList(true)
    const handle = ctx.setTimeout(() => {
      filterRef.current = { query, category }
      loadList(query, category)
    }, query === '' && category === '' ? 0 : 220)
    return handle
  }, [ctx, query, category, loadList])

  // Background refresh, skipped while any draft is unsaved so a poll can never
  // reorder the list under an edit (and never touch the editor at all).
  useEffect(() => {
    return ctx.setInterval(() => {
      if (dirtyIds.size === 0) {
        loadList()
      }
    }, POLL_MS)
  }, [ctx, dirtyIds, loadList])

  const openNote = useCallback(
    async (id) => {
      selectedRef.current = id
      ctx.storage.set(SELECTED_KEY, id)
      setSaveState('')
      setSaveError('')
      const cached = draftsRef.current.get(id)
      if (cached) {
        setDraft(cached)
        return
      }
      try {
        const note = await ctx.rest(`/notes/${id}`)
        const value = {
          id: note.id,
          title: note.title || '',
          content: note.content || '',
          category: note.category || '',
          favorite: Boolean(note.favorite),
          modified: note.modified,
          readonly: Boolean(note.readonly),
          base: ''
        }
        value.base = signature(value)
        draftsRef.current.set(id, value)
        setDraft(value)
        recomputeDirty()
      } catch (error) {
        setSaveError(`Could not open note ${id}: ${errorText(error)}`)
      }
    },
    [ctx, recomputeDirty]
  )

  // Restore the last opened note once the list has loaded.
  const restoredRef = useRef(false)
  useEffect(() => {
    if (restoredRef.current || rows.length === 0) {
      return
    }
    restoredRef.current = true
    const stored = ctx.storage.get(SELECTED_KEY, null)
    const pick = stored != null && rows.some(row => row.id === stored) ? stored : rows[0].id
    openNote(pick)
  }, [rows, ctx, openNote])

  const patchDraft = useCallback(
    (patch) => {
      const current = draftsRef.current.get(selectedRef.current)
      if (!current) {
        return
      }
      const next = { ...current, ...patch }
      draftsRef.current.set(current.id, next)
      setDraft(next)
      setSaveState('')
      setSaveError('')
      recomputeDirty()
    },
    [recomputeDirty]
  )

  const saveDraft = useCallback(async () => {
    const current = draftsRef.current.get(selectedRef.current)
    if (!current || signature(current) === current.base || current.readonly) {
      return
    }
    setSaveState('saving')
    setSaveError('')
    try {
      const note = await ctx.rest(`/notes/${current.id}`, {
        method: 'PUT',
        body: {
          title: current.title,
          content: current.content,
          category: current.category,
          favorite: current.favorite,
          modified: current.modified
        }
      })
      const value = {
        id: note.id,
        title: note.title || '',
        content: note.content || '',
        category: note.category || '',
        favorite: Boolean(note.favorite),
        modified: note.modified,
        readonly: Boolean(note.readonly),
        base: ''
      }
      value.base = signature(value)
      draftsRef.current.set(note.id, value)
      setDraft(currentDraft => (currentDraft && currentDraft.id === note.id ? value : currentDraft))
      setSaveState('saved')
      recomputeDirty()
      loadList()
    } catch (error) {
      setSaveState('error')
      setSaveError(errorText(error))
    }
  }, [ctx, loadList, recomputeDirty])

  const createNote = useCallback(async () => {
    try {
      const title = 'New note'
      const note = await ctx.rest('/notes', { method: 'POST', body: { title, content: '' } })
      draftsRef.current.delete(note.id)
      await loadList()
      await openNote(note.id)
      setSaveState('')
    } catch (error) {
      setListError(errorText(error))
    }
  }, [ctx, loadList, openNote])

  const deleteNote = useCallback(async () => {
    const current = draft
    if (!current) {
      return
    }
    if (!window.confirm(`Delete "${current.title || 'Untitled'}" from Nextcloud Notes?`)) {
      return
    }
    try {
      await ctx.rest(`/notes/${current.id}`, { method: 'DELETE' })
      draftsRef.current.delete(current.id)
      setDraft(null)
      selectedRef.current = null
      recomputeDirty()
      await loadList()
    } catch (error) {
      setSaveError(`Delete failed: ${errorText(error)}`)
    }
  }, [ctx, draft, loadList, recomputeDirty])

  const discardDraft = useCallback(() => {
    if (!draft) {
      return
    }
    draftsRef.current.delete(draft.id)
    setDraft(null)
    recomputeDirty()
    openNote(draft.id)
  }, [draft, openNote, recomputeDirty])

  // Ctrl/Cmd+S saves the open note from anywhere on this page.
  useEffect(() => {
    return ctx.addEventListener(window, 'keydown', event => {
      if ((event.metaKey || event.ctrlKey) && (event.key === 's' || event.key === 'S')) {
        event.preventDefault()
        saveDraft()
      }
    })
  }, [ctx, saveDraft])

  const dirty = draft ? signature(draft) !== draft.base : false
  const wordCount = draft ? (draft.content.trim() ? draft.content.trim().split(/\s+/).length : 0) : 0

  const statusText = (() => {
    if (!draft) {
      return ''
    }
    if (saveState === 'saving') {
      return 'Saving…'
    }
    if (saveState === 'saved') {
      return `Saved ${clockTime(draft.modified)}`
    }
    if (dirty) {
      return 'Unsaved changes'
    }
    return `In sync · ${relTime(draft.modified)}`
  })()

  const list = useMemo(
    () =>
      rows.map(row =>
        h(
          'button',
          {
            key: row.id,
            type: 'button',
            className: `nc-row${draft && draft.id === row.id ? ' nc-row--active' : ''}`,
            onClick: () => openNote(row.id)
          },
          h(
            'div',
            { className: 'nc-row__head' },
            h('span', { className: 'nc-row__title' }, dirtyIds.has(row.id) ? '● ' : '', row.title),
            row.favorite ? h('span', { className: 'nc-star nc-star--on', title: 'Favorite' }, '★') : null
          ),
          row.excerpt ? h('div', { className: 'nc-row__excerpt' }, row.excerpt) : null,
          h(
            'div',
            { className: 'nc-row__foot' },
            row.category ? h('span', { className: 'nc-tag' }, row.category) : null,
            h('span', null, relTime(row.modified)),
            dirtyIds.has(row.id) ? h('span', { className: 'nc-dot' }) : null
          )
        )
      ),
    [rows, draft, dirtyIds, openNote]
  )

  return h(
    'div',
    { className: 'nc-page' },
    h(
      'div',
      { className: 'nc-bar' },
      h('span', { className: 'nc-bar__title' }, 'Notes'),
      h('span', { className: 'nc-chip' }, `${rows.length}${loadingList ? '…' : ''}`),
      h('input', {
        className: 'nc-input nc-search',
        placeholder: 'Search titles and text',
        value: query,
        onChange: event => setQuery(event.target.value)
      }),
      h(
        'select',
        {
          className: 'nc-select',
          value: category,
          onChange: event => setCategory(event.target.value)
        },
        h('option', { value: '' }, 'All categories'),
        categories.map(name => h('option', { key: name, value: name }, name))
      ),
      h('button', { type: 'button', className: 'nc-btn', onClick: () => loadList() }, 'Refresh'),
      h('button', { type: 'button', className: 'nc-btn nc-btn--primary', onClick: createNote }, 'New note')
    ),
    listError ? h('div', { className: 'nc-error' }, listError) : null,
    h(
      'div',
      { className: 'nc-body' },
      h('div', { className: 'nc-list' }, h('div', { className: 'nc-list__scroll' }, list)),
      draft
        ? h(
            'div',
            { className: 'nc-editor' },
            h(
              'div',
              { className: 'nc-editor__head' },
              h('input', {
                className: 'nc-title-input',
                value: draft.title,
                placeholder: 'Untitled',
                readOnly: draft.readonly,
                onChange: event => patchDraft({ title: event.target.value })
              }),
              h(
                'button',
                {
                  type: 'button',
                  className: `nc-star${draft.favorite ? ' nc-star--on' : ''}`,
                  title: draft.favorite ? 'Remove from favorites' : 'Add to favorites',
                  onClick: () => patchDraft({ favorite: !draft.favorite })
                },
                draft.favorite ? '★' : '☆'
              )
            ),
            h(
              'div',
              { className: 'nc-meta' },
              h('input', {
                className: 'nc-input',
                style: { maxWidth: '220px' },
                value: draft.category,
                placeholder: 'Category (folder)',
                readOnly: draft.readonly,
                onChange: event => patchDraft({ category: event.target.value })
              }),
              h('span', null, `Modified ${relTime(draft.modified) || 'unknown'}`),
              h('span', null, `${wordCount} words`),
              draft.readonly ? h('span', { className: 'nc-tag' }, 'readonly') : null
            ),
            saveError ? h('div', { className: 'nc-error' }, saveError) : null,
            h('textarea', {
              className: 'nc-body-input',
              value: draft.content,
              readOnly: draft.readonly,
              spellCheck: true,
              placeholder: 'Write in markdown…',
              onChange: event => patchDraft({ content: event.target.value })
            }),
            h(
              'div',
              { className: 'nc-foot' },
              h('span', null, statusText),
              h('span', { className: 'nc-foot__spacer' }),
              h('span', { className: 'nc-hint' }, 'Ctrl+S to save'),
              dirty ? h('button', { type: 'button', className: 'nc-btn', onClick: discardDraft }, 'Revert') : null,
              h(
                'button',
                {
                  type: 'button',
                  className: 'nc-btn',
                  title: 'Keep this note in the side pane, beside the chat',
                  onClick: () => showRail(draft.id)
                },
                'Side pane'
              ),
              h('button', { type: 'button', className: 'nc-btn nc-btn--danger', onClick: deleteNote }, 'Delete'),
              h(
                'button',
                {
                  type: 'button',
                  className: 'nc-btn nc-btn--primary',
                  disabled: !dirty || saveState === 'saving' || draft.readonly,
                  onClick: saveDraft
                },
                'Save'
              )
            )
          )
        : h(
            'div',
            { className: 'nc-empty' },
            h('span', null, loadingList ? 'Loading notes…' : 'No note open'),
            h('span', { className: 'nc-hint' }, 'Pick a note on the left, or create one.')
          )
    )
  )
}

const NAV_ICON = 'notebook'

export default {
  id: 'notes',
  name: 'Notes',
  description: 'Nextcloud Notes: read and write the /Notes folder from Hermes',
  defaultEnabled: true,
  register(ctx) {
    ctx.registerMany([
      {
        id: 'page',
        area: ROUTES_AREA,
        data: { path: PAGE_PATH },
        render: () => h(NotesPage, { ctx })
      },
      {
        id: 'nav',
        area: SIDEBAR_NAV_AREA,
        order: 24,
        data: { path: PAGE_PATH, label: 'Notes', codicon: NAV_ICON }
      },
      {
        // One note in the right rail, beside the chat, the way the terminal
        // docks. Contribution-scoped pane id: notes:rail.
        id: 'rail',
        area: 'panes',
        title: 'Note',
        data: { placement: 'right', minWidth: '20rem' },
        render: () => h(NoteRail, { ctx })
      }
    ])
  }
}
