#!/usr/bin/env node
/**
 * Rendering gate for the Notes plugin.
 *
 * The markdown renderer and the title/first-line helpers are pure functions, so
 * they can be lifted out of `desktop/plugin.js` and exercised without a browser
 * or React. That matters because "it looks right in the app" is not a check
 * anyone can repeat: these assertions are.
 *
 * The slice is taken between the `// --- markdown` banner and the
 * `// --- side-rail pane` banner, so the test fails loudly if a refactor moves
 * those functions out of that region.
 */

import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = new URL('..', import.meta.url).pathname
const source = readFileSync(join(ROOT, 'desktop', 'plugin.js'), 'utf8')

const START = '// --- markdown'
const END = '// --- side-rail pane'
const from = source.indexOf(START)
const to = source.indexOf(END)
if (from < 0 || to < 0 || to <= from) {
  console.error('FAIL: could not find the markdown / side-rail banners in desktop/plugin.js')
  process.exit(1)
}

const EXPORTS = ['escapeHtml', 'safeLink', 'renderInline', 'renderMarkdown', 'toggleTaskLine', 'firstHeading', 'setTitleLine', 'withTitleTouched']
const slice = `${source.slice(from, to)}\nexport { ${EXPORTS.join(', ')} }\n`

const dir = mkdtempSync(join(tmpdir(), 'notes-render-'))
const modulePath = join(dir, 'markdown.mjs')
writeFileSync(modulePath, slice, 'utf8')

const failures = []
const mod = await import(pathToFileURL(modulePath).href)
rmSync(dir, { recursive: true, force: true })

function check(name, actual, expected) {
  const ok = typeof expected === 'function' ? expected(actual) : actual === expected
  if (!ok) {
    failures.push(`${name}\n    got: ${String(actual).slice(0, 400)}`)
  }
}
const has = (needle) => (text) => text.includes(needle)
const lacks = (needle) => (text) => !text.includes(needle)
const all = (...tests) => (text) => tests.every((test) => test(text))

const { renderMarkdown, renderInline, firstHeading, setTitleLine, withTitleTouched, safeLink, toggleTaskLine } = mod

// --- blocks ----------------------------------------------------------------
check('heading', renderMarkdown('# Title\n\ntext'), all(has('<h1>Title</h1>'), has('<p>text</p>')))
check('heading levels', renderMarkdown('## One\n### Two'), all(has('<h2>One</h2>'), has('<h3>Two</h3>')))
check('paragraph keeps soft line breaks', renderMarkdown('one\ntwo'), has('<p>one<br>two</p>'))
check('blank line splits paragraphs', renderMarkdown('one\n\ntwo'), all(has('<p>one</p>'), has('<p>two</p>')))
check('horizontal rule', renderMarkdown('a\n\n---\n\nb'), has('<hr>'))
check('blockquote', renderMarkdown('> quoted line'), all(has('<blockquote>'), has('quoted line'), lacks('&gt;')))

// --- lists and tasks -------------------------------------------------------
check(
  'bulleted list',
  renderMarkdown('- one\n- two'),
  all(has('<ul><li>one</li><li>two</li></ul>'), lacks('&lt;li&gt;'))
)
check('ordered list', renderMarkdown('1. one\n2. two'), has('<ol><li>one</li><li>two</li></ol>'))
check(
  'nested list',
  renderMarkdown('- a\n  - b\n- c'),
  has('<ul><li>a<ul><li>b</li></ul></li><li>c</li></ul>')
)
check(
  'mixed nesting keeps its own tag',
  renderMarkdown('- a\n  1. b'),
  all(has('<ul><li>a<ol><li>b</li></ol></li></ul>'), lacks('<ol><li>a'))
)
const tasks = renderMarkdown('- [ ] open item\n- [x] done item\n- [X] also done')
check('task checkboxes', tasks, all(has('type="checkbox"'), has('data-line="0"'), has('data-line="1"')))
check('task state', tasks, (text) => (text.match(/checked/g) || []).length === 2)
check('task class', tasks, has('class="nc-task"'))
check('task keeps inline markdown', renderMarkdown('- [ ] **bold** item'), has('<strong>bold</strong>'))

// --- code, tables ----------------------------------------------------------
check(
  'fenced code is escaped',
  renderMarkdown('```js\nconst x = 1 < 2\n```'),
  all(has('<pre><code class="language-js">const x = 1 &lt; 2</code></pre>'), lacks('< 2'))
)
check('inline code', renderInline('use `a < b` here'), has('<code>a &lt; b</code>'))
check(
  'table',
  renderMarkdown('| Item | Price |\n|---|---|\n| Switch | 29 |'),
  all(has('<table>'), has('<th>Item</th>'), has('<td>Switch</td>'), has('<td>29</td>'))
)

// --- inline ----------------------------------------------------------------
check('bold', renderInline('**bold**'), has('<strong>bold</strong>'))
check('italic star', renderInline('an *italic* word'), has('<em>italic</em>'))
check('italic underscore', renderInline('an _italic_ word'), has('<em>italic</em>'))
check('bold underscore', renderInline('__bold__'), has('<strong>bold</strong>'))
check('strikethrough', renderInline('~~gone~~'), has('<del>gone</del>'))
check('bold inside a link label', renderInline('[**x**](https://a.b)'), has('<strong>x</strong>'))
check('markdown link', renderInline('[site](https://example.com/a)'), has('<a href="https://example.com/a"'))
check('bare url becomes a link', renderInline('see https://example.com/x now'), has('<a href="https://example.com/x"'))
check('image', renderInline('![alt](https://example.com/i.png)'), has('<img src="https://example.com/i.png" alt="alt"'))

// --- safety ----------------------------------------------------------------
check('html in a note is escaped', renderMarkdown('<script>alert(1)</script>'), all(lacks('<script'), has('&lt;script&gt;')))
check('javascript: link is dropped', renderInline('[x](javascript:alert(1))'), all(lacks('javascript:'), has('x')))
check('data: link is dropped', renderInline('[x](data:text/html,hi)'), lacks('data:text/html'))
check('safeLink keeps http', safeLink('https://example.com'), 'https://example.com')
check('safeLink keeps anchors', safeLink('#section'), '#section')
check('safeLink drops file:', safeLink('file:///etc/passwd'), '')

// --- ticking a task --------------------------------------------------------
const taskNote = '- [ ] first item\n- [x] second item\nplain row'
check('tick turns a task on', toggleTaskLine(taskNote, 0), '- [x] first item\n- [x] second item\nplain row')
check('tick turns a task off', toggleTaskLine(taskNote, 1), '- [ ] first item\n- [ ] second item\nplain row')
check('tick keeps the rest of the line', toggleTaskLine('- [ ] a **bold** item with a tail', 0), '- [x] a **bold** item with a tail')
check('tick keeps nested indentation', toggleTaskLine('  - [ ] nested', 0), '  - [x] nested')
check('tick accepts a capital X', toggleTaskLine('- [X] done', 0), '- [ ] done')
check('tick refuses a non-task row', toggleTaskLine(taskNote, 2), null)
check('tick refuses an out of range index', toggleTaskLine(taskNote, 9), null)
check('tick keeps the line count', toggleTaskLine(taskNote, 0).split('\n').length, 3)
check('tick on every task of the sample', (() => {
  let content = '- [ ] a\n- [ ] b'
  content = toggleTaskLine(content, 0)
  content = toggleTaskLine(content, 1)
  return content === '- [x] a\n- [x] b'
})(), true)

// --- title and first line --------------------------------------------------
check('first heading', firstHeading('# My note\n\nbody'), 'My note')
check('first heading skips blank lines', firstHeading('\n\n# Second line title\nbody'), 'Second line title')
check('no heading gives no title', firstHeading('just prose\nmore'), '')
check('rename rewrites the heading', setTitleLine('# Old\n\nbody', 'New'), '# New\n\nbody')
check('rename keeps a deeper heading level', setTitleLine('## Old\n\nbody', 'New'), '## New\n\nbody')
check('rename leaves a heading-less note alone', setTitleLine('prose only', 'New'), 'prose only')
check('rename fills an empty note', setTitleLine('', 'New'), '# New')
check('body edit moves the title', withTitleTouched({ title: 'Old', content: '# Old' }, { content: '# Fresh\n\nbody' }).title, 'Fresh')
check('body edit without a heading keeps the title', withTitleTouched({ title: 'Old', content: '' }, { content: 'prose' }).title, 'Old')
check(
  'title edit moves the heading',
  withTitleTouched({ title: 'Old', content: '# Old\n\nbody' }, { title: 'New' }).content,
  '# New\n\nbody'
)

// --- a real note, the shape the Nextcloud app writes ----------------------
const sample = [
  '# Shopping List',
  '## Homelab switch',
  '',
  '- [ ] **TP-Link Omada ES208G** : $29 excluding VAT.',
  '- [x] Patch cables',
  '',
  '### Notes',
  '',
  '> Prices seen 16 Nov 2026.',
  '',
  '| Shop | Price |',
  '| --- | --- |',
  '| Ayoub | 29 |',
  '',
  'Contact: https://example.com/pricing',
  '',
  '---',
  '',
  'Prose with a *date* and `code`, no dashes allowed in this file.'
].join('\n')
const rendered = renderMarkdown(sample)
check('sample note: headings', rendered, all(has('<h1>Shopping List</h1>'), has('<h2>Homelab switch</h2>')))
check('sample note: no leftover markdown syntax', rendered, all(lacks('**'), lacks('- [ ]'), lacks('## '), lacks('| --- |')))
check('sample note: table and quote', rendered, all(has('<table>'), has('<blockquote>')))
check('sample note: autolink', rendered, has('href="https://example.com/pricing"'))
check('sample note: rule', rendered, has('<hr>'))

if (failures.length) {
  console.error(`FAILED: ${failures.length} rendering check(s)`)
  for (const item of failures) {
    console.error(`  - ${item}`)
  }
  process.exit(1)
}

console.log('rendering checks passed')
