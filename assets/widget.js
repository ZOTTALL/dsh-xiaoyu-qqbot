/* QQ BOT public plugin：右侧蓝色细把手是唯一入口。
 * 把手独立固定定位；关闭的抽屉完全隐藏，不留下屏外子元素。
 * 让出顶部标题栏，保留收起、Esc、外部点击及标题栏刷新入口。
 */
(function () {
  var destroy = null
  try {
    var previous = window.__DSH_PUBLIC_QQBOT_WIDGET__
    if (previous && typeof previous.destroy === 'function') previous.destroy()
    else if (previous) {
      // 兼容旧版只写 boolean 标记的注入：先移除旧 UI，再建立唯一实例。
      ;['dshpubqq-fab', 'dshpubqq-handle', 'dshpubqq-drawer', 'dshpubqq-reload-fallback', 'dshpubqq-widget-style'].forEach(function (id) {
        var old = document.getElementById(id)
        if (old) old.remove()
      })
      var styles = document.head && document.head.children ? document.head.children : []
      for (var si = styles.length - 1; si >= 0; --si) {
        if (styles[si].tagName === 'STYLE' && /#dshpubqq-fab/.test(styles[si].textContent || '')) styles[si].remove()
      }
      delete window.__DSH_PUBLIC_QQBOT_WIDGET__
    }

    var BASE = '/dsh-xiaoyu-qqbot'
    var WIDTH = 'min(600px, calc(100vw - 24px))'
    var alive = true
    var listeners = []
    var nodes = []
    var timers = []
    var frame = null
    var expanded = false
    var polling = false
    var statusText = 'QQ BOT：状态检测中；链路：状态检测中'
    var abort = typeof AbortController === 'function' ? new AbortController() : null
    var instance = { destroy: function () { destroy() } }
    window.__DSH_PUBLIC_QQBOT_WIDGET__ = instance

    function listen(target, event, fn, options) {
      target.addEventListener(event, fn, options)
      listeners.push(function () { target.removeEventListener(event, fn, options) })
    }
    function own(node, parent) { nodes.push(node); parent.appendChild(node); return node }
    destroy = function () {
      if (!alive) return
      alive = false
      if (abort) abort.abort()
      timers.forEach(function (id) { clearInterval(id); clearTimeout(id) })
      listeners.forEach(function (remove) { remove() })
      nodes.forEach(function (node) { node.remove() })
      if (window.__DSH_PUBLIC_QQBOT_WIDGET__ === instance) delete window.__DSH_PUBLIC_QQBOT_WIDGET__
    }

    var css = document.createElement('style')
    css.id = 'dshpubqq-widget-style'
    css.textContent =
      '#dshpubqq-drawer,#dshpubqq-handle{--dshpubqq-top:46px;box-sizing:border-box}' +
      '#dshpubqq-drawer{position:fixed;right:0;top:var(--dshpubqq-top);height:calc(100vh - var(--dshpubqq-top));width:' + WIDTH + ';z-index:2147483001;' +
      'background:#fff;box-shadow:-10px 0 30px rgba(0,0,0,.28);display:flex;flex-direction:column;font:13px/1.4 system-ui,"Microsoft YaHei",sans-serif}' +
      '#dshpubqq-drawer[hidden]{display:none}' +
      '#dshpubqq-drawer iframe{flex:1;border:0;width:100%;min-height:0}' +
      '#dshpubqq-bar{display:flex;align-items:center;gap:8px;padding:5px 8px;background:#0f172a;color:#e2e8f0}' +
      '#dshpubqq-bar button{background:#1e293b;color:#e2e8f0;border:1px solid #334155;border-radius:6px;padding:2px 9px;cursor:pointer;font:inherit}' +
      '#dshpubqq-bar button:hover{background:#334155}' +
      '#dshpubqq-collapse{font-weight:600}' +
      '#dshpubqq-handle{position:fixed;right:0;top:calc(65% + var(--dshpubqq-top)/2);transform:translateY(-50%);width:24px;max-height:calc(100vh - var(--dshpubqq-top));padding:12px 3px;' +
      'z-index:2147483002;border:0;border-radius:7px 0 0 7px;background:#1d4ed8;color:#fff;cursor:pointer;writing-mode:vertical-rl;letter-spacing:2px;' +
      'font:12px/18px system-ui,"Microsoft YaHei",sans-serif;box-shadow:-2px 0 8px rgba(0,0,0,.18)}' +
      '#dshpubqq-handle[aria-expanded="true"]{right:' + WIDTH + '}' +
      '#dshpubqq-handle:hover{background:#2563eb}' +
      '#dshpubqq-handle:focus-visible{outline:2px solid #38bdf8;outline-offset:-2px}' +
      '@media(max-width:600px){#dshpubqq-drawer,#dshpubqq-handle{--dshpubqq-top:40px}}'
    own(css, document.head)

    var drawer = document.createElement('div')
    drawer.id = 'dshpubqq-drawer'
    drawer.hidden = true
    drawer.setAttribute('role', 'region')
    drawer.setAttribute('aria-label', 'QQ BOT 控制台')
    drawer.setAttribute('aria-hidden', 'true')
    var bar = document.createElement('div')
    bar.id = 'dshpubqq-bar'
    var collapse = document.createElement('button')
    collapse.id = 'dshpubqq-collapse'
    collapse.type = 'button'
    collapse.textContent = '‹ 收起'
    var heading = document.createElement('span')
    heading.textContent = 'QQ BOT 控制台'
    bar.appendChild(collapse)
    bar.appendChild(heading)
    drawer.appendChild(bar)
    own(drawer, document.body)

    var handle = document.createElement('button')
    handle.id = 'dshpubqq-handle'
    handle.type = 'button'
    handle.setAttribute('aria-controls', drawer.id)
    own(handle, document.body)
    function renderHandle() {
      handle.textContent = expanded ? '收起' : '展开'
      handle.setAttribute('aria-expanded', String(expanded))
      handle.setAttribute('aria-label', (expanded ? '收起' : '展开') + 'QQ BOT 控制台')
      handle.title = statusText + (expanded ? '（点击收起，Esc）' : '（点击展开面板）')
    }
    function open() {
      if (!frame) {
        frame = document.createElement('iframe')
        frame.title = 'QQ BOT 控制台'
        frame.setAttribute('allow', 'fullscreen')
        frame.setAttribute('allowfullscreen', '')
        frame.src = BASE + '/ui' // 同源浏览器认证、cookie 原样保留
        drawer.appendChild(frame)
      }
      expanded = true
      drawer.hidden = false
      drawer.classList.add('open')
      drawer.setAttribute('aria-hidden', 'false')
      if (frame && frame.contentWindow) frame.contentWindow.postMessage?.({ type: 'dshpubqq-visibility', value: true }, location.origin)
      renderHandle()
    }
    function close() {
      var restoreFocus = drawer.contains(document.activeElement)
      expanded = false
      drawer.style.width = ''
      handle.style.right = ''
      if (frame && frame.contentWindow) frame.contentWindow.postMessage?.({ type: 'dshpubqq-visibility', value: false }, location.origin)
      drawer.hidden = true
      drawer.classList.remove('open')
      drawer.setAttribute('aria-hidden', 'true')
      renderHandle()
      if (restoreFocus) handle.focus()
    }
    renderHandle()
    listen(handle, 'click', function () { if (expanded) close(); else open() })
    listen(collapse, 'click', close)
    listen(document, 'mousedown', function (e) {
      if (expanded && !drawer.contains(e.target) && !handle.contains(e.target)) close()
    }, true)
    listen(document, 'keydown', function (e) {
      if (e.key === 'Escape' && expanded) close()
    })
    listen(window, 'message', function (e) {
      if (!e || !frame || e.origin !== location.origin || e.source !== frame.contentWindow || !e.data) return
      if (e.data.type === 'dshpubqq-memory-wide') {
        drawer.style.width = e.data.value ? 'min(1420px, calc(100vw - 24px))' : ''
        handle.style.right = e.data.value && expanded ? 'min(1420px, calc(100vw - 24px))' : ''
      } else if (e.data.type === 'dshpubqq-close') close()
      else if (e.data.type === 'dshpubqq-reload') location.reload()
    })

    // 沿用 Windows 标题栏菜单；非 Windows / 未挂载时保留左上角刷新后备钮。
    function installReloadItem() {
      var host = document.querySelector('[data-windows-menu]')
      if (!host || !host.shadowRoot) return false
      var menu = host.shadowRoot.querySelector('[role="menubar"]')
      if (!menu) return false
      var fallback = document.getElementById('dshpubqq-reload-fallback')
      if (fallback) fallback.remove()
      if (menu.querySelector('[data-dshpubqq-reload]')) return true
      var zh = (document.documentElement.lang || '').toLowerCase().indexOf('zh') === 0
      var b = document.createElement('button')
      b.type = 'button'
      b.tabIndex = -1
      b.setAttribute('data-dshpubqq-reload', '')
      b.textContent = zh ? '刷新' : 'Reload'
      b.title = zh ? '重新加载页面（载入最新插件代码）· Ctrl+Alt+R' : 'Reload page (load latest plugin code) · Ctrl+Alt+R'
      listen(b, 'click', function (e) { e.preventDefault(); location.reload() })
      own(b, menu)
      return true
    }
    if (!installReloadItem()) {
      var tries = 0
      var iv = setInterval(function () { if (installReloadItem() || ++tries > 40) clearInterval(iv) }, 250)
      timers.push(iv)
      timers.push(setTimeout(function () {
        if (installReloadItem() || document.getElementById('dshpubqq-reload-fallback')) return
        var f = document.createElement('button')
        f.id = 'dshpubqq-reload-fallback'
        f.type = 'button'
        f.textContent = '⟳ 刷新'
        f.title = '重新加载页面（Ctrl+Alt+R）'
        f.style.cssText = 'position:fixed;left:8px;top:46px;z-index:2147482999;padding:2px 8px;border-radius:999px;' +
          'border:1px solid rgba(120,140,180,.5);background:rgba(255,255,255,.82);color:#334155;font:12px system-ui;cursor:pointer;opacity:.6'
        listen(f, 'mouseenter', function () { f.style.opacity = '1' })
        listen(f, 'mouseleave', function () { f.style.opacity = '.6' })
        listen(f, 'click', function () { location.reload() })
        own(f, document.body)
      }, 2500))
    }
    listen(document, 'keydown', function (e) {
      if (e.ctrlKey && e.altKey && (e.key === 'r' || e.key === 'R')) { e.preventDefault(); location.reload() }
    }, true)

    function poll() {
      if (!alive || polling) return
      polling = true
      var options = { cache: 'no-store', credentials: 'same-origin' }
      if (abort) options.signal = abort.signal
      fetch(BASE + '/api/ping', options).then(function (r) {
        if (!r.ok) throw new Error('ping failed')
        return r.json()
      }).then(function (s) {
        if (!alive) return
        s = s || {}
        var online = !!s.bot
        var blocked = s.login && s.login.phase === 'blocked'
        var chain = s.chain === 'ok' ? '在线' : s.chain === 'degraded' ? '异常' : '未知'
        handle.setAttribute('data-status', blocked ? 'bad' : online && s.chain === 'ok' ? 'ok' : online ? 'warn' : 'bad')
        statusText = 'QQ BOT：' + (online ? '在线' : '离线') + '；链路：' + chain
        if (!online && s.login && s.login.message) statusText += '；' + s.login.message
        renderHandle()
      }).catch(function () {
        if (!alive) return
        handle.setAttribute('data-status', 'unknown')
        statusText = 'QQ BOT：状态未知；链路：状态未知（状态服务不可达）'
        renderHandle()
      }).then(function () { polling = false })
    }
    handle.setAttribute('data-status', 'unknown')
    poll()
    timers.push(setInterval(poll, 8000))
  } catch (e) { if (destroy) destroy() }
})()
