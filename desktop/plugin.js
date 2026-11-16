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
const VIEW_KEY = 'notes.view'
const POLL_MS = 90_000
const LIST_MARK = /^\s*(?:[-*+]|\d{1,9}[.)])\s+/
const TASK_MARK = /^\s*(?:[-*+]|\d{1,9}[.)])\s+\[[ xX]\]\s+/
const MARK_KINDS = {
  bullet: /^\s*[-*+](?!\s+\[[ xX]\])\s+/,
  number: /^\s*\d{1,9}[.)]\s+/,
  task: /^\s*[-*+]\s+\[[ xX]\]\s+/
}

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
    /* Markdown: Write, Split and Preview share one typographic scale, so a
       note reads the same whichever half you are looking at. */
    .nc-toolbar { display: flex; align-items: center; gap: 3px; flex: 0 0 auto;
      flex-wrap: wrap; padding: 0 12px 6px; }
    .nc-tool { border: 1px solid transparent; border-radius: 5px; cursor: pointer;
      background: transparent; color: var(--ui-text-secondary); font-family: inherit;
      font-size: 11.5px; line-height: 1.5; min-width: 24px; padding: 2px 6px; }
    .nc-tool:hover { background: color-mix(in srgb, var(--ui-text-primary) 9%, transparent);
      color: var(--ui-text-primary); }
    .nc-tool:disabled { opacity: 0.4; cursor: default; background: transparent; }
    .nc-toolbar__sep { width: 1px; height: 15px; margin: 0 3px;
      background: var(--ui-stroke-secondary); }
    .nc-toolbar__spacer { flex: 1 1 auto; }
    .nc-seg { display: inline-flex; border: 1px solid var(--ui-stroke-secondary);
      border-radius: 6px; overflow: hidden; }
    .nc-seg__btn { border: 0; cursor: pointer; background: transparent; font-family: inherit;
      color: var(--ui-text-tertiary); font-size: 11px; padding: 3px 9px; }
    .nc-seg__btn--on { background: color-mix(in srgb, var(--ui-accent) 20%, transparent);
      color: var(--ui-text-primary); font-weight: 600; }
    .nc-panes { display: flex; flex: 1 1 auto; min-height: 0; min-width: 0; }
    .nc-panes > .nc-body-input { flex: 1 1 50%; min-width: 0; }
    .nc-md { flex: 1 1 50%; min-width: 0; min-height: 0; overflow-y: auto;
      padding: 2px 16px 28px; font-size: 13px; line-height: 1.65;
      color: var(--ui-text-primary); overflow-wrap: break-word; }
    .nc-panes--split > .nc-md { border-left: 1px solid var(--ui-stroke-secondary); }
    .nc-md > :first-child { margin-top: 0; }
    .nc-md h1, .nc-md h2, .nc-md h3, .nc-md h4, .nc-md h5, .nc-md h6 {
      margin: 1.05em 0 0.35em; line-height: 1.25; font-weight: 650; }
    .nc-md h1 { font-size: 19px; }
    .nc-md h2 { font-size: 16px; }
    .nc-md h3 { font-size: 14px; }
    .nc-md h4, .nc-md h5, .nc-md h6 { font-size: 13px; color: var(--ui-text-secondary); }
    .nc-md p { margin: 0.5em 0; }
    .nc-md ul, .nc-md ol { margin: 0.4em 0; padding-left: 1.5em; }
    .nc-md li { margin: 0.15em 0; }
    .nc-md li > ul, .nc-md li > ol { margin: 0.15em 0; }
    .nc-md code { padding: 0.1em 0.35em; border-radius: 4px; font-size: 0.92em;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      background: color-mix(in srgb, var(--ui-text-primary) 9%, transparent); }
    .nc-md pre { margin: 0.6em 0; padding: 9px 11px; overflow-x: auto; border-radius: 6px;
      border: 1px solid var(--ui-stroke-secondary);
      background: color-mix(in srgb, var(--ui-text-primary) 7%, transparent); }
    .nc-md pre code { background: transparent; padding: 0; font-size: 12px; }
    .nc-md blockquote { margin: 0.6em 0; padding: 0.1em 0 0.1em 11px;
      color: var(--ui-text-secondary); border-left: 2px solid var(--ui-stroke-secondary); }
    .nc-md hr { border: 0; border-top: 1px solid var(--ui-stroke-secondary); margin: 1.1em 0; }
    .nc-md a { color: var(--ui-accent); text-decoration: none; }
    .nc-md a:hover { text-decoration: underline; }
    .nc-md img { max-width: 100%; border-radius: 6px; }
    .nc-md table { border-collapse: collapse; margin: 0.6em 0; font-size: 12.5px; }
    .nc-md th, .nc-md td { border: 1px solid var(--ui-stroke-secondary);
      padding: 4px 8px; text-align: left; }
    .nc-md th { font-weight: 600;
      background: color-mix(in srgb, var(--ui-text-primary) 6%, transparent); }
    .nc-md li.nc-task { list-style: none; margin-left: -1.15em; }
    .nc-md input[type="checkbox"] { margin-right: 6px; vertical-align: baseline;
      accent-color: var(--ui-accent); }
    .nc-md__empty { color: var(--ui-text-tertiary); }
    .nc-rail__toggle { cursor: pointer; border: 1px solid var(--ui-stroke-secondary);
      border-radius: 5px; background: transparent; color: var(--ui-text-tertiary);
      font-family: inherit; font-size: 11px; padding: 1px 7px; }
    .nc-rail__md { flex: 1 1 auto; min-height: 0; overflow-y: auto;
      padding: 8px 10px; font-size: 12.5px; line-height: 1.6; overflow-wrap: break-word; }
    /* Narrow windows: one column, the list above the note, panes stacked. */
    @media (max-width: 860px) {
      .nc-bar { flex-wrap: wrap; row-gap: 6px; }
      .nc-search { max-width: none; }
      .nc-body { flex-direction: column; }
      .nc-list { width: auto; min-width: 0; max-height: 32%;
        border-right: 0; border-bottom: 1px solid var(--ui-stroke-secondary); }
      .nc-panes--split { flex-direction: column; }
      .nc-panes--split > .nc-md { border-left: 0;
        border-top: 1px solid var(--ui-stroke-secondary); }
      .nc-foot { flex-wrap: wrap; row-gap: 6px; }
    }
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

// --- markdown ---------------------------------------------------------------
// A note is a plain Markdown file in the Nextcloud account, the same one the web
// editor and the phone app open, so the preview has to read the same dialect:
// the first line is `# Title`, tasks are `- [ ]`, tables use pipes. This is that
// subset, rendered to an HTML string with every source character escaped first,
// so note text can never inject markup, and only real link targets survive.

const SAFE_LINK = /^(https?:\/\/|mailto:|#|\/|\.\/|\.\.\/)/i
const URL_SCHEME = /^[a-z][a-z0-9+.-]*:/i
const FENCE_RE = /^\s{0,3}(```+|~~~+)\s*([\w+#.-]*)\s*$/
const HEADING_RE = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/
const RULE_RE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/
const ITEM_RE = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/
const QUOTE_RE = /^\s{0,3}>\s?(.*)$/
const TABLE_SEP_RE = /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/
const TITLE_RE = /^\s{0,3}#{1,6}\s+(.*\S)\s*#*\s*$/

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function safeLink(raw) {
  const url = String(raw || '').trim()
  if (!url) {
    return ''
  }
  if (SAFE_LINK.test(url)) {
    return url
  }
  // Anything else that names a scheme (javascript:, data:, file:) is dropped.
  return URL_SCHEME.test(url) ? '' : url
}

function renderInline(text) {
  const held = []
  const hold = html => `\u0000${held.push(html) - 1}\u0000`
  let html = escapeHtml(text)
  html = html.replace(/`([^`]+)`/g, (_match, code) => hold(`<code>${code}</code>`))
  html = html.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_match, alt, src) => {
    const url = safeLink(src)
    return url ? hold(`<img src="${url}" alt="${alt}" loading="lazy">`) : alt
  })
  html = html.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_match, label, href) => {
    const url = safeLink(href)
    return url
      ? hold(`<a href="${url}" target="_blank" rel="noreferrer">${renderInline(label)}</a>`)
      : label
  })
  html = html.replace(/(^|[\s(])(https?:\/\/[^\s<)\u0000]+)/g, (_match, lead, url) => {
    const href = safeLink(url)
    return href ? `${lead}${hold(`<a href="${href}" target="_blank" rel="noreferrer">${href}</a>`)}` : `${lead}${url}`
  })
  html = html.replace(/~~([^~]+)~~/g, '<del>$1</del>')
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  html = html.replace(/__([^_]+)__/g, '<strong>$1</strong>')
  html = html.replace(/(^|[^\w*])\*([^*\s](?:[^*]*[^*\s])?)\*/g, '$1<em>$2</em>')
  html = html.replace(/(^|[^\w_])_([^_\s](?:[^_]*[^_\s])?)_/g, '$1<em>$2</em>')
  return html.replace(/\u0000(\d+)\u0000/g, (_match, index) => held[Number(index)] || '')
}

function renderList(items) {
  let html = ''
  const open = []
  const close = () => {
    const top = open.pop()
    html += `</li></${top.tag}>`
  }
  for (const item of items) {
    if (!open.length) {
      html += `<${item.tag}>`
      open.push({ depth: item.depth, tag: item.tag })
    } else {
      while (open.length && item.depth < open[open.length - 1].depth) {
        close()
      }
      if (item.depth > open[open.length - 1].depth) {
        html += `<${item.tag}>`
        open.push({ depth: item.depth, tag: item.tag })
      } else {
        html += '</li>'
      }
    }
    html += `<li${item.task ? ' class="nc-task"' : ''}>${item.html}`
  }
  while (open.length) {
    close()
  }
  return html
}

function splitRow(row) {
  return row
    .replace(/^\s*\|/, '')
    .replace(/\|\s*$/, '')
    .split('|')
    .map(cell => cell.trim())
}

function renderMarkdown(source) {
  const lines = String(source || '').replace(/\r\n?/g, '\n').split('\n')
  const html = []
  let paragraph = []
  let items = []
  let index = 0

  const flushParagraph = () => {
    if (paragraph.length) {
      html.push(`<p>${paragraph.map(renderInline).join('<br>')}</p>`)
      paragraph = []
    }
  }
  const flushItems = () => {
    if (items.length) {
      html.push(renderList(items))
      items = []
    }
  }
  const flushAll = () => {
    flushParagraph()
    flushItems()
  }

  while (index < lines.length) {
    const line = lines[index]

    if (!line.trim()) {
      flushAll()
      index += 1
      continue
    }

    const fence = line.match(FENCE_RE)
    if (fence) {
      flushAll()
      const marker = fence[1].slice(0, 3)
      const language = fence[2] || ''
      const body = []
      index += 1
      while (index < lines.length && !lines[index].trim().startsWith(marker)) {
        body.push(lines[index])
        index += 1
      }
      index += 1 // step past the closing fence (or the end of the note)
      const langClass = language ? ` class="language-${language}"` : ''
      html.push(`<pre><code${langClass}>${escapeHtml(body.join('\n'))}</code></pre>`)
      continue
    }

    const heading = line.match(HEADING_RE)
    if (heading) {
      flushAll()
      const level = heading[1].length
      html.push(`<h${level}>${renderInline(heading[2])}</h${level}>`)
      index += 1
      continue
    }

    if (RULE_RE.test(line)) {
      flushAll()
      html.push('<hr>')
      index += 1
      continue
    }

    if (
      line.includes('|') &&
      index + 1 < lines.length &&
      TABLE_SEP_RE.test(lines[index + 1]) &&
      lines[index + 1].includes('|')
    ) {
      flushAll()
      const head = splitRow(line)
      index += 2
      const rows = []
      while (index < lines.length && lines[index].trim() && lines[index].includes('|')) {
        rows.push(splitRow(lines[index]))
        index += 1
      }
      html.push(
        `<table><thead><tr>${head.map(cell => `<th>${renderInline(cell)}</th>`).join('')}</tr></thead>` +
          `<tbody>${rows
            .map(row => `<tr>${row.map(cell => `<td>${renderInline(cell)}</td>`).join('')}</tr>`)
            .join('')}</tbody></table>`
      )
      continue
    }

    const quote = line.match(QUOTE_RE)
    if (quote) {
      flushAll()
      const inner = []
      while (index < lines.length) {
        const quoted = lines[index].match(QUOTE_RE)
        if (!quoted) {
          break
        }
        inner.push(quoted[1])
        index += 1
      }
      html.push(`<blockquote>${renderMarkdown(inner.join('\n'))}</blockquote>`)
      continue
    }

    const item = line.match(ITEM_RE)
    if (item) {
      flushParagraph()
      const indent = item[1].replace(/\t/g, '    ').length
      const tag = /\d/.test(item[2]) ? 'ol' : 'ul'
      const task = item[3].match(/^\[([ xX])\]\s*(.*)$/)
      let content
      if (task) {
        const checked = task[1] === ' ' ? '' : ' checked'
        content = `<input type="checkbox"${checked} data-line="${index}">${renderInline(task[2])}`
      } else {
        content = renderInline(item[3])
      }
      items.push({ depth: Math.floor(indent / 2), tag, task: Boolean(task), html: content })
      index += 1
      continue
    }

    flushItems()
    paragraph.push(line.trim())
    index += 1
  }

  flushAll()
  return html.join('\n')
}

// Ticking a checkbox in the preview has to be a real edit of one source line.
// Returns null when that line is not a task, so callers can no-op without
// guessing: the index comes from a rendered string, not from the draft.

function toggleTaskLine(content, lineIndex) {
  const rows = String(content || '').replace(/\r\n?/g, '\n').split('\n')
  const row = rows[lineIndex]
  const match = row == null ? null : row.match(/^(\s*(?:[-*+]|\d{1,9}[.)])\s+\[)([ xX])(\]\s?)(.*)$/)
  if (!match) {
    return null
  }
  rows[lineIndex] = `${match[1]}${match[2] === ' ' ? 'x' : ' '}${match[3]}${match[4]}`
  return rows.join('\n')
}

// --- title and first line ---------------------------------------------------
// Nextcloud keeps the note title beside the file, and its own editor keeps the
// first `# heading` in step with it. Two surfaces that disagree produce a note
// whose name and body say different things, so title edits rewrite the heading
// and heading edits rewrite the title.

function firstHeading(content) {
  for (const line of String(content || '').replace(/\r\n?/g, '\n').split('\n')) {
    if (!line.trim()) {
      continue
    }
    const match = line.match(TITLE_RE)
    return match ? match[1].trim() : ''
  }
  return ''
}

function setTitleLine(content, title) {
  const rows = String(content || '').replace(/\r\n?/g, '\n').split('\n')
  const at = rows.findIndex(line => line.trim() !== '')
  if (at === -1) {
    // An empty note gets its heading now, exactly as the web editor would.
    return title ? `# ${title}` : ''
  }
  const heading = rows[at].match(/^\s{0,3}(#{1,6})\s+/)
  if (!heading) {
    return content
  }
  const tail = rows[at].match(/\s+#*\s*$/)
  rows[at] = `${heading[1]} ${title}${tail && /\s+#/.test(tail[0]) ? ' ' + tail[0].trim() : ''}`
  return rows.join('\n')
}

function withTitleTouched(draft, patch) {
  const next = { ...draft, ...patch }
  if (patch.title !== undefined && patch.content === undefined) {
    next.content = setTitleLine(draft.content, patch.title)
  } else if (patch.content !== undefined && patch.title === undefined) {
    const derived = firstHeading(next.content)
    if (derived) {
      next.title = derived
    }
  }
  return next
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
  const [showPreview, setShowPreview] = useState(false)

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
        onChange: event =>
          setDraft(current => (current ? withTitleTouched(current, { title: event.target.value }) : current))
      })
    ),
    error ? h('div', { className: 'nc-error' }, error) : null,
    showPreview
      ? h('div', {
          className: 'nc-rail__md nc-md',
          dir: 'auto',
          onClick: event => {
            const target = event.target
            if (!target || target.tagName !== 'INPUT' || target.type !== 'checkbox') {
              return
            }
            const lineIndex = Number(target.getAttribute('data-line'))
            setDraft(current => {
              if (!current || current.readonly || Number.isNaN(lineIndex)) {
                return current
              }
              const next = toggleTaskLine(current.content, lineIndex)
              return next === null ? current : { ...current, content: next }
            })
          },
          dangerouslySetInnerHTML: {
            __html: draft ? renderMarkdown(draft.content) || '<p class="nc-md__empty">Nothing written yet.</p>' : ''
          }
        })
      : h('textarea', {
          className: 'nc-rail__body',
          value: draft ? draft.content : '',
          readOnly: !draft || draft.readonly,
          placeholder: 'Pin a note here from the Notes page.',
          onChange: event =>
            setDraft(current => (current ? withTitleTouched(current, { content: event.target.value }) : current))
        }),
    h(
      'div',
      { className: 'nc-rail__foot' },
      h('span', null, state === 'saving' ? 'Saving…' : dirty ? 'Unsaved' : draft ? relTime(draft.modified) : ''),
      h('span', { className: 'nc-rail__spacer' }),
      h(
        'button',
        {
          type: 'button',
          className: 'nc-rail__toggle',
          title: showPreview ? 'Back to editing' : 'Render the markdown',
          onClick: () => setShowPreview(value => !value)
        },
        showPreview ? 'Write' : 'Preview'
      ),
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
  const [viewMode, setViewMode] = useState(() => {
    const stored = ctx.storage.get(VIEW_KEY, null)
    if (stored === 'write' || stored === 'split' || stored === 'preview') {
      return stored
    }
    return typeof window !== 'undefined' && window.innerWidth >= 980 ? 'split' : 'write'
  })

  const draftsRef = useRef(new Map())
  const filterRef = useRef({ query: '', category: '' })
  const selectedRef = useRef(null)
  const textareaRef = useRef(null)

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
      const next = withTitleTouched(current, patch)
      draftsRef.current.set(current.id, next)
      setDraft(next)
      setSaveState('')
      setSaveError('')
      recomputeDirty()
    },
    [recomputeDirty]
  )

  // --- editor commands ------------------------------------------------------
  // The toolbar and the keyboard both drive these. Everything edits the draft
  // through patchDraft, so the title/first-line sync and the dirty marker keep
  // working exactly as they do for typing.

  const focusRange = useCallback((start, end) => {
    window.setTimeout(() => {
      const node = textareaRef.current
      if (!node) {
        return
      }
      node.focus()
      node.setSelectionRange(start, end)
    }, 0)
  }, [])

  const wrapSelection = useCallback(
    (before, after = before, placeholder = 'text') => {
      const current = draftsRef.current.get(selectedRef.current)
      if (!current || current.readonly) {
        return
      }
      const node = textareaRef.current
      const content = current.content
      const start = node ? node.selectionStart : content.length
      const end = node ? node.selectionEnd : content.length
      const chosen = content.slice(start, end) || placeholder
      patchDraft({ content: content.slice(0, start) + before + chosen + after + content.slice(end) })
      focusRange(start + before.length, start + before.length + chosen.length)
    },
    [focusRange, patchDraft]
  )

  const formatBlock = useCallback(
    (kind) => {
      const current = draftsRef.current.get(selectedRef.current)
      if (!current || current.readonly) {
        return
      }
      const node = textareaRef.current
      const content = current.content
      const start = node ? node.selectionStart : 0
      const end = node ? node.selectionEnd : content.length
      const from = content.lastIndexOf('\n', Math.max(0, start - 1)) + 1
      let to = content.indexOf('\n', end)
      if (to === -1) {
        to = content.length
      }
      const rows = content.slice(from, to).split('\n')
      const every = test => rows.every(row => test(row))
      let next

      if (kind === 'h1' || kind === 'h2' || kind === 'h3') {
        const hashes = '#'.repeat(Number(kind.slice(1)))
        const on = every(row => row.trimStart().startsWith(`${hashes} `))
        next = rows.map(row => {
          const bare = row.replace(/^\s*#{1,6}\s+/, '')
          return on ? bare : `${hashes} ${bare}`
        })
      } else if (kind === 'quote') {
        const on = every(row => /^\s*>/.test(row))
        next = rows.map(row => (on ? row.replace(/^\s*>\s?/, '') : `> ${row}`))
      } else if (kind === 'code') {
        const fenced = rows.length > 2 && rows[0].trim().startsWith('```') && rows[rows.length - 1].trim().startsWith('```')
        next = fenced ? rows.slice(1, -1) : ['```', ...rows, '```']
      } else if (MARK_KINDS[kind]) {
        const on = every(row => MARK_KINDS[kind].test(row))
        next = rows.map((row, index) => {
          const bare = row.replace(TASK_MARK, '').replace(LIST_MARK, '')
          if (on) {
            return bare
          }
          if (kind === 'number') {
            return `${index + 1}. ${bare}`
          }
          return kind === 'task' ? `- [ ] ${bare}` : `- ${bare}`
        })
      } else {
        return
      }

      const text = next.join('\n')
      patchDraft({ content: content.slice(0, from) + text + content.slice(to) })
      focusRange(from, from + text.length)
    },
    [focusRange, patchDraft]
  )

  const onBodyKeyDown = useCallback(
    (event) => {
      const node = event.currentTarget
      const mod = event.metaKey || event.ctrlKey
      if (mod && !event.shiftKey) {
        const key = event.key.toLowerCase()
        if (key === 'b') {
          event.preventDefault()
          wrapSelection('**')
          return
        }
        if (key === 'i') {
          event.preventDefault()
          wrapSelection('_')
          return
        }
        if (key === 'k') {
          event.preventDefault()
          wrapSelection('[', '](https://)')
          return
        }
      }
      if (event.key === 'Enter' && !event.shiftKey && !mod) {
        const head = node.value.slice(0, node.selectionStart)
        const line = head.slice(head.lastIndexOf('\n') + 1)
        const task = line.match(/^(\s*)([-*+])\s+\[[ xX]\]\s+/)
        const bullet = line.match(/^(\s*)([-*+])\s+/)
        const numbered = line.match(/^(\s*)(\d{1,9})([.)])\s+/)
        let insert = ''
        if (task) {
          insert = `\n${task[1]}${task[2]} [ ] `
        } else if (bullet) {
          insert = `\n${bullet[1]}${bullet[2]} `
        } else if (numbered) {
          insert = `\n${numbered[1]}${Number(numbered[2]) + 1}${numbered[3]} `
        }
        if (!insert) {
          return
        }
        event.preventDefault()
        const next = node.value.slice(0, node.selectionStart) + insert + node.value.slice(node.selectionEnd)
        patchDraft({ content: next })
        focusRange(node.selectionStart + insert.length, node.selectionStart + insert.length)
      }
    },
    [focusRange, patchDraft, wrapSelection]
  )

  // A checkbox clicked in the preview is a real edit: it rewrites that source
  // line, so the phone and the web app see the tick too.
  const onPreviewClick = useCallback(
    (event) => {
      const target = event.target
      if (!target || target.tagName !== 'INPUT' || target.type !== 'checkbox') {
        return
      }
      const current = draftsRef.current.get(selectedRef.current)
      const lineIndex = Number(target.getAttribute('data-line'))
      if (!current || current.readonly || Number.isNaN(lineIndex)) {
        return
      }
      const next = toggleTaskLine(current.content, lineIndex)
      if (next === null) {
        return
      }
      patchDraft({ content: next })
    },
    [patchDraft]
  )

  const setView = useCallback((next) => {
    setViewMode(next)
    ctx.storage.set(VIEW_KEY, next)
  }, [ctx])

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

  const previewHtml = useMemo(() => {
    if (!draft || viewMode === 'write') {
      return ''
    }
    const rendered = renderMarkdown(draft.content)
    return rendered || '<p class="nc-md__empty">Nothing written yet.</p>'
  }, [draft, viewMode])

  const tool = (label, title, run, style) =>
    h(
      'button',
      {
        type: 'button',
        className: 'nc-tool',
        title,
        style: style || null,
        disabled: !draft || draft.readonly || viewMode === 'preview',
        // Keep the caret where it is: a toolbar click must not blur the body.
        onMouseDown: event => event.preventDefault(),
        onClick: run
      },
      label
    )

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
            h(
              'div',
              { className: 'nc-toolbar' },
              tool('H1', 'Heading', () => formatBlock('h1')),
              tool('H2', 'Subheading', () => formatBlock('h2')),
              h('span', { className: 'nc-toolbar__sep' }),
              tool('B', 'Bold (Ctrl+B)', () => wrapSelection('**'), { fontWeight: 700 }),
              tool('I', 'Italic (Ctrl+I)', () => wrapSelection('_'), { fontStyle: 'italic' }),
              tool('S', 'Strikethrough', () => wrapSelection('~~'), { textDecoration: 'line-through' }),
              tool('<>', 'Inline code', () => wrapSelection('`')),
              h('span', { className: 'nc-toolbar__sep' }),
              tool('•', 'Bulleted list', () => formatBlock('bullet')),
              tool('1.', 'Numbered list', () => formatBlock('number')),
              tool('☑', 'Checklist', () => formatBlock('task')),
              tool('❝', 'Quote', () => formatBlock('quote')),
              tool('¶', 'Code block', () => formatBlock('code')),
              tool('Link', 'Link (Ctrl+K)', () => wrapSelection('[', '](https://)')),
              h('span', { className: 'nc-toolbar__spacer' }),
              h(
                'div',
                { className: 'nc-seg' },
                [
                  ['write', 'Write'],
                  ['split', 'Split'],
                  ['preview', 'Preview']
                ].map(([key, label]) =>
                  h(
                    'button',
                    {
                      key,
                      type: 'button',
                      className: `nc-seg__btn${viewMode === key ? ' nc-seg__btn--on' : ''}`,
                      title: key === 'split' ? 'Write and preview side by side' : `${label} only`,
                      onClick: () => setView(key)
                    },
                    label
                  )
                )
              )
            ),
            h(
              'div',
              { className: `nc-panes${viewMode === 'split' ? ' nc-panes--split' : ''}` },
              viewMode === 'preview'
                ? null
                : h('textarea', {
                    ref: textareaRef,
                    className: 'nc-body-input',
                    value: draft.content,
                    readOnly: draft.readonly,
                    spellCheck: true,
                    placeholder: 'Write in markdown…',
                    onChange: event => patchDraft({ content: event.target.value }),
                    onKeyDown: onBodyKeyDown
                  }),
              viewMode === 'write'
                ? null
                : h('div', {
                    className: 'nc-md',
                    dir: 'auto',
                    onClick: onPreviewClick,
                    dangerouslySetInnerHTML: { __html: previewHtml }
                  })
            ),
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
