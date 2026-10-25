import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import fs from 'node:fs'

const source = fs.readFileSync(new URL('../assets/widget.js', import.meta.url), 'utf8')

class MockEventTarget {
  constructor() { this.listeners = new Map() }
  addEventListener(type, fn) { const list = this.listeners.get(type) || []; list.push(fn); this.listeners.set(type, list) }
  removeEventListener(type, fn) { this.listeners.set(type, (this.listeners.get(type) || []).filter((x) => x !== fn)) }
  dispatch(type, event = {}) { for (const fn of [...(this.listeners.get(type) || [])]) fn(event) }
}
class MockElement extends MockEventTarget {
  constructor(tag) { super(); this.tagName = tag.toUpperCase(); this.children = []; this.parentNode = null; this.attributes = {}; this.style = {}; this.hidden = false; this.textContent = ''; this.innerHTML = ''; this.id = ''; this.className = ''; this.title = ''; this.type = ''; this.tabIndex = 0; this.shadowRoot = null; this.classList = { add: (...xs) => { xs.forEach((x) => { this.className = (this.className + ' ' + x).trim() }) }, remove: (...xs) => { xs.forEach((x) => { this.className = this.className.split(/\\s+/).filter((y) => y && y !== x).join(' ') }) }, contains: (x) => this.className.split(/\\s+/).includes(x) } }
  appendChild(child) { this.children.push(child); child.parentNode = this; if (child.tagName === 'IFRAME' && !child.contentWindow) child.contentWindow = {}; return child }
  append(child) { return this.appendChild(child) }
  remove() { if (!this.parentNode) return; this.parentNode.children = this.parentNode.children.filter((x) => x !== this); this.parentNode = null }
  setAttribute(name, value) { this.attributes[name] = String(value) }
  getAttribute(name) { return this.attributes[name] ?? null }
  contains(node) { return node === this || this.children.some((child) => child.contains(node)) }
  querySelector(selector) {
    const match = (node) => selector.startsWith('#') ? node.id === selector.slice(1) : selector.startsWith('[') ? node.attributes[selector.slice(1, -1)] !== undefined : false
    for (const child of this.children) { if (match(child)) return child; const nested = child.querySelector(selector); if (nested) return nested }
    return null
  }
  focus() { this.ownerDocument.activeElement = this }
}
function makeDom() {
  const document = new MockEventTarget()
  document.createElement = (tag) => { const node = new MockElement(tag); node.ownerDocument = document; return node }
  document.documentElement = { lang: 'zh-CN' }
  document.head = document.createElement('head')
  document.body = document.createElement('body')
  document.activeElement = document.body
  document.querySelector = (selector) => selector === '[data-windows-menu]' ? null : document.head.querySelector(selector) || document.body.querySelector(selector)
  document.getElementById = (id) => document.querySelector('#' + id)
  document.activeElement = document.body
  return document
}
function run({ fetchResult = { bot: true, chain: 'ok' } } = {}) {
  const document = makeDom()
  const window = new MockEventTarget()
  window.document = document
  window.location = { origin: 'http://localhost', reloadCalled: 0, reload() { this.reloadCalled++ } }
  window.setInterval = () => 1
  window.clearInterval = () => {}
  window.setTimeout = () => 2
  window.clearTimeout = () => {}
  window.AbortController = class { constructor() { this.signal = {} } abort() {} }
  window.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve(fetchResult) })
  const context = { window, document, location: window.location, fetch: window.fetch, setInterval: window.setInterval, clearInterval: window.clearInterval, setTimeout: window.setTimeout, clearTimeout: window.clearTimeout, AbortController: window.AbortController, console }
  vm.runInNewContext(source, context)
  return { document, window, context }
}

async function flush() { await new Promise((resolve) => setImmediate(resolve)); await new Promise((resolve) => setImmediate(resolve)) }

test('single edge handle opens and closes drawer without FAB or popup button', async () => {
  const { document } = run()
  await flush()
  const handle = document.getElementById('dshqq-handle')
  const drawer = document.getElementById('dshqq-drawer')
  assert.ok(handle)
  assert.equal(document.getElementById('dshqq-fab'), null)
  assert.equal(document.getElementById('dshqq-pop'), null)
  assert.equal(handle.textContent, '展开')
  assert.equal(handle.getAttribute('aria-expanded'), 'false')
  assert.match(handle.title, /QQ BOT：在线；链路：在线/)
  handle.dispatch('click')
  assert.equal(drawer.hidden, false)
  assert.equal(drawer.getAttribute('aria-hidden'), 'false')
  assert.equal(handle.textContent, '收起')
  assert.equal(handle.getAttribute('aria-expanded'), 'true')
  assert.equal(drawer.children.some((x) => x.tagName === 'IFRAME'), true)
  handle.dispatch('click')
  assert.equal(drawer.hidden, true)
  assert.equal(handle.getAttribute('aria-expanded'), 'false')
  assert.equal(drawer.contains(handle), false)
})

test('status tooltip reflects bot and chain state, including degraded/offline', async () => {
  const { document } = run({ fetchResult: { bot: true, chain: 'degraded' } })
  await flush()
  const handle = document.getElementById('dshqq-handle')
  assert.equal(handle.getAttribute('data-status'), 'warn')
  assert.match(handle.title, /QQ BOT：在线；链路：异常/)
})

test('outside click and validated frame messages close/reload only from same frame', async () => {
  const { document, window } = run()
  const handle = document.getElementById('dshqq-handle')
  const drawer = document.getElementById('dshqq-drawer')
  handle.dispatch('click')
  const frame = drawer.children.find((x) => x.tagName === 'IFRAME')
  window.dispatch('message', { origin: 'https://evil.example', source: frame.contentWindow, data: { type: 'dshqq-close' } })
  assert.equal(drawer.hidden, false)
  window.dispatch('message', { origin: 'http://localhost', source: {}, data: { type: 'dshqq-close' } })
  assert.equal(drawer.hidden, false)
  window.dispatch('message', { origin: 'http://localhost', source: frame.contentWindow, data: { type: 'dshqq-close' } })
  assert.equal(drawer.hidden, true)
  handle.dispatch('click')
  window.dispatch('message', { origin: 'http://localhost', source: frame.contentWindow, data: { type: 'dshqq-reload' } })
  assert.equal(window.location.reloadCalled, 1)
  document.dispatch('mousedown', { target: document.body })
  assert.equal(drawer.hidden, true)
})

test('reinjection destroys previous instance instead of duplicating UI', () => {
  const first = run()
  const before = first.document.body.children.filter((x) => x.id === 'dshqq-handle').length
  assert.equal(before, 1)
  vm.runInNewContext(source, first.context)
  assert.equal(first.document.body.children.filter((x) => x.id === 'dshqq-handle').length, 1)
  assert.equal(first.document.body.children.filter((x) => x.id === 'dshqq-drawer').length, 1)
})
