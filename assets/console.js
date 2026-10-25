/* QQ BOT 控制台页面脚本 */
(function () {
  'use strict'
  var API = '/dsh-xiaoyu-qqbot/api/'
  var $ = function (id) { return document.getElementById(id) }
  var csrf = ''
  var state = { status: null, settings: null, doc: null, tab: 'overview', qrTick: 0 }

  function toast(msg, bad) {
    var t = $('toast'); t.textContent = msg; t.style.background = bad ? '#b91c1c' : '#0f172a'
    t.classList.add('show'); clearTimeout(toast._t); toast._t = setTimeout(function () { t.classList.remove('show') }, 2800)
  }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] }) }
  function get(ep, q) {
    return fetch(API + ep + (q ? '?' + new URLSearchParams(q) : ''), { cache: 'no-store' }).then(function (r) { return r.json() })
  }
  function post(ep, body, raw) {
    var p = csrf ? Promise.resolve() : get('csrf').then(function (j) { csrf = j.token })
    return p.then(function () {
      return fetch(API + ep, { method: 'POST', headers: Object.assign({ 'x-dsh-csrf': csrf }, raw ? {} : { 'content-type': 'application/json' }), body: raw || JSON.stringify(body || {}) })
    }).then(function (r) { return r.json() }).then(function (j) {
      if (j && j.ok === false && j.error) throw new Error(j.error)
      return j
    })
  }
  function act(btn, fn, okMsg) {
    var old = btn && btn.textContent
    if (btn) { btn.disabled = true }
    return Promise.resolve().then(fn).then(function (r) { if (okMsg) toast(okMsg); return r })
      .catch(function (e) { toast(e.message || String(e), true) })
      .then(function (r) { if (btn) { btn.disabled = false; btn.textContent = old } refresh(); return r })
  }

  // ── Tabs ──
  document.querySelectorAll('#tabs button').forEach(function (b) {
    b.onclick = function () { gotoTab(b.dataset.tab) }
  })
  document.addEventListener('click', function (e) {
    var a = e.target.closest('[data-goto]')
    if (a) { e.preventDefault(); gotoTab(a.dataset.goto) }
  })
  function gotoTab(name) {
    document.querySelectorAll('#tabs button').forEach(function (x) { x.classList.toggle('on', x.dataset.tab === name) })
    document.querySelectorAll('main > section').forEach(function (s) { s.classList.toggle('on', s.id === 'tab-' + name) })
    state.tab = name; onTab(name)
  }
  var loaded = {}
  function onTab(t) {
    if (t === 'login') refreshQr()
    if (t === 'voice') loadVoice()
    if (t === 'stickers') loadStickers()
    if (t === 'persona' && !loaded.docs) { loaded.docs = 1; loadDocs() }
    if (t === 'limits') loadParams()
    if (t === 'tasks') loadTasks()
    if (t === 'logs') { renderLog() }
    if (t === 'settings') loadSettings()
  }

  // ── 总览 / 服务卡片 ──
  var SVC = [
    { key: 'astrbot', name: 'AstrBot', port: 'astrbotUi', desc: 'QQ ⇄ DSH 网关 (6185)', deployKey: 'astrbot' },
    { key: 'napcat', name: 'NapCat', port: 'napcat', desc: 'QQ 协议端 (3002)', deployKey: 'napcat' },
    { key: 'tts', name: 'GPT-SoVITS 语音', port: 'tts', desc: '语音合成服务 (9880)', deployKey: 'tts' },
    { key: 'ingress', name: 'DSH ingress', port: 'ingress', desc: '桌面端接入 (3188)，由 DSH 提供', fixed: true },
  ]
  function renderCards(s) {
    var h = ''
    var dep = (state.settings && state.settings.deploy) || {}
    SVC.forEach(function (v) {
      var up = s.ports[v.port]
      var sub = v.key === 'napcat' ? (s.bot ? '已登录：' + esc(s.bot.nick) : esc(s.login.message || '未登录')) : v.desc
      var cls = up ? (v.key === 'napcat' && !s.bot ? 'warn' : 'ok') : 'bad'
      h += '<div class="card"><div class="t"><span class="dot ' + cls + '"></span>' + v.name + '</div><div class="s">' + sub + '</div><div class="b">'
      if (!v.fixed) {
        var installed = dep[v.deployKey]
        if (installed === false) {
          h += '<button class="deploy" data-op="deploy" data-t="' + v.deployKey + '">一键部署</button>'
        } else {
          h += up ? '<button data-op="restart" data-t="' + v.key + '"' + (v.key === 'tts' ? ' hidden' : '') + '>重启</button><button class="danger" data-op="stop" data-t="' + v.key + '">停止</button>'
            : '<button class="primary" data-op="start" data-t="' + v.key + '">启动</button>'
          h += ' <button class="deploy mini" data-op="deploy" data-t="' + v.deployKey + '" title="重新检查/补装">重新部署</button>'
        }
      }
      h += '</div></div>'
    })
    $('svc-cards').innerHTML = h
    $('svc-cards').querySelectorAll('button[data-op]').forEach(function (b) {
      b.onclick = function () {
        if (b.dataset.op === 'deploy') { runDeploy(b, b.dataset.t); return }
        act(b, function () { return post(b.dataset.op, { target: b.dataset.t }) }, (b.textContent) + '已执行')
      }
    })
  }
  function runDeploy(btn, target) {
    act(btn, function () {
      toast('开始部署 ' + target + '，进度见“日志”页')
      return post('deploy', { target: target }).then(function (r) { return pollDeployJob(r.job.id) })
    }, '部署流程已结束，查看日志确认结果')
  }
  function pollDeployJob(id) {
    return new Promise(function (resolve, reject) {
      var n = 0
      var tick = function () {
        get('deploy/job', { id: id }).then(function (r) {
          var job = r.job
          if (!job || job.status === 'missing') return reject(new Error('部署任务丢失'))
          if (job.status === 'running') { if (++n > 600) return reject(new Error('部署超时（10 分钟）')); return setTimeout(tick, 1000) }
          resolve(job)
        }).catch(reject)
      }
      tick()
    })
  }
  function renderChip(s) {
    var c = $('chip'); var online = !!s.bot
    c.className = 'chip ' + (online && s.chain === 'ok' ? 'ok' : s.login.phase === 'blocked' ? 'bad' : online ? 'warn' : 'bad')
    c.textContent = online ? ('在线 · ' + s.bot.nick) : (s.login.phase === 'blocked' ? '被风控' : s.ports.astrbotUi ? 'NapCat 未登录' : '离线')
    $('setup-banner').hidden = s.configured !== false
  }

  function refresh() {
    return get('status').then(function (s) {
      state.status = s; renderChip(s); renderCards(s); renderLogin(s)
    }).catch(function () { $('chip').className = 'chip bad'; $('chip').textContent = '控制台接口不可用' })
  }

  // ── 登录 / 二维码 ──
  var PHASE = { unknown: ['未知', ''], stopped: ['NapCat 未运行', 'bad'], starting: ['启动中…', 'warn'], qr: ['等待扫码', 'warn'], scanned: ['已扫码，等待确认', 'warn'], online: ['已登录', 'ok'], blocked: ['账号被风控', 'bad'], error: ['登录异常', 'bad'] }
  function renderLogin(s) {
    var p = PHASE[s.login.phase] || PHASE.unknown
    var el = $('login-state'); el.textContent = s.bot ? '已登录 · ' + s.bot.nick : p[0]; el.className = 'bigstate ' + (s.bot ? 'ok' : p[1])
    $('login-msg').textContent = s.login.message || ''
    var help = ''
    if (s.login.phase === 'blocked') help = '腾讯返回 168：“账号近期存在安全风险”。\n① 用手机 QQ 登录机器人账号，按提示完成安全验证 / 恢复账号；\n② 回到这里点“重启 NapCat 刷新二维码”；\n③ 用同一部手机扫码并点“确认登录”。'
    else if (s.login.phase === 'qr') help = '用登录着机器人账号的手机 QQ 扫码，并点“确认登录”。二维码约 2 分钟过期，页面会自动刷新。'
    else if (s.login.phase === 'stopped') help = 'NapCat 没有运行：点右上角“一键启动”，没装过先在“总览”点“一键部署”。'
    $('login-help').textContent = help
    $('qr-meta').textContent = s.qr.exists ? ('二维码生成于 ' + s.qr.ageSec + ' 秒前' + (s.qr.ageSec > 120 ? '（可能已过期）' : '')) : ''
    if (state.tab === 'login') refreshQr()
  }
  function refreshQr() {
    var s = state.status; if (!s) return
    var show = s.qr.exists && !s.bot && s.login.phase !== 'stopped'
    $('qr-img').hidden = !show; $('qr-empty').hidden = show
    if (s.bot) $('qr-empty').textContent = '机器人账号已在线，无需扫码'
    else $('qr-empty').textContent = '当前没有等待扫码的二维码'
    if (show) { var u = API + 'qr.png?t=' + s.qr.mtime; if ($('qr-img').dataset.u !== u) { $('qr-img').dataset.u = u; $('qr-img').src = u } }
  }
  $('b-qr-refresh').onclick = function () { act(this, function () { return post('restart', { target: 'napcat' }) }, '正在重启 NapCat，几秒后出新二维码') }
  $('b-qr-copy').onclick = function () {
    var u = state.status && state.status.login.qrUrl
    if (!u) return toast('还没有二维码链接', true)
    navigator.clipboard.writeText(u).then(function () { toast('已复制') }, function () { toast(u) })
  }

  // ── 抽屉内也能收起（postMessage 给宿主页的挂件）──
  if (window.parent && window.parent !== window) {
    $('b-collapse').hidden = false
    $('b-collapse').onclick = function () { try { window.parent.postMessage({ type: 'dshqq-close' }, '*') } catch (e) {} }
    $('b-reload').hidden = false
    $('b-reload').onclick = function () { try { window.parent.postMessage({ type: 'dshqq-reload' }, '*') } catch (e) {} }
  }

  // ── 全局按钮 ──
  $('b-all-start').onclick = function () { act(this, function () { return post('start', { target: 'all' }) }, '已启动 AstrBot + NapCat') }
  $('b-all-stop').onclick = function () { if (confirm('停止 NapCat 和 AstrBot？QQ 将不再收发。')) act(this, function () { return post('stop', { target: 'all' }) }, '已停止') }

  // ── 体检 / 守护配置 ──
  function loadDiag() {
    return get('diagnose').then(function (d) {
      $('diag').innerHTML = d.items.map(function (i) {
        return '<li>' + (i.ok ? '✅' : '❌') + ' ' + esc(i.name) + (i.hint ? '<div class="h">' + esc(i.hint) + '</div>' : '') + '</li>'
      }).join('')
    })
  }
  $('b-diag').onclick = function () { act(this, loadDiag) }
  function loadCfg() {
    return get('config').then(function (c) {
      $('wd-enabled').checked = !!c.watchdog.enabled; $('wd-astrbot').checked = !!c.watchdog.restartAstrbot; $('wd-napcat').checked = !!c.watchdog.restartNapcat
      $('as-astrbot').checked = !!c.autostart.astrbot; $('as-napcat').checked = !!c.autostart.napcat; $('as-tts').checked = !!c.autostart.tts
    })
  }
  $('b-save-cfg').onclick = function () {
    act(this, function () {
      return post('config', { patch: {
        watchdog: { enabled: $('wd-enabled').checked, restartAstrbot: $('wd-astrbot').checked, restartNapcat: $('wd-napcat').checked },
        autostart: { astrbot: $('as-astrbot').checked, napcat: $('as-napcat').checked, tts: $('as-tts').checked },
      } })
    }, '已保存')
  }
  $('b-send').onclick = function () {
    var t = $('send-text').value.trim(); if (!t) return toast('先写点内容', true)
    act(this, function () { return post('send', { text: t }).then(function () { $('send-text').value = '' }) }, '已发送')
  }
  $('b-metrics').onclick = function () { act(this, function () { $('metrics').textContent = '查询中…'; return get('metrics').then(function (r) { $('metrics').textContent = r.text || '（无输出）' }) }) }

  // ── 语音 ──
  function loadVoice() {
    get('voice/config').then(function (r) {
      var sel = $('v-ref'); sel.innerHTML = ''
      var cur = (r.cfg.ref_audio || '').split(/[\\/]/).pop()
      r.refs.forEach(function (f) {
        var o = document.createElement('option'); o.value = f.name; o.textContent = f.name + ' (' + f.kb + 'KB)'
        if (f.name === cur) o.selected = true; sel.appendChild(o)
      })
      $('v-prompt').value = r.cfg.prompt_text || ''
      state.voiceDir = (r.cfg.ref_audio || '').replace(/[^\\/]+$/, '')
      var selected = sel.value || cur
      $('v-ref-preview').src = selected ? API + 'voice/ref?name=' + encodeURIComponent(selected) : ''
      sel.onchange = function () {
        $('v-ref-preview').src = sel.value ? API + 'voice/ref?name=' + encodeURIComponent(sel.value) : ''
      }
    })
    var s = state.status; $('tts-state').textContent = s && s.ports.tts ? '● 语音服务运行中' : '○ 语音服务未启动（合成时会自动拉起，首句约 8 秒）'
  }
  function say(send) {
    var t = $('v-text').value.trim(); if (!t) return toast('文本为空', true)
    var btn = send ? $('b-v-send') : $('b-v-play')
    act(btn, function () {
      $('v-out').textContent = '合成中…'
      return post('voice/say', { text: t, send: send, speed: Number($('v-speed').value) || 1 }).then(function (r) {
        $('v-out').textContent = (r.stdout || '').trim() || (r.ok ? '完成' : r.stderr)
        if (!r.ok) throw new Error('合成失败：' + (r.stderr || r.stdout))
      })
    }, send ? '语音已发到 QQ' : '合成完成（可在试听区回放）')
  }
  $('b-v-play').onclick = function () { say(false) }
  $('b-v-send').onclick = function () { say(true) }
  $('b-tts-start').onclick = function () { act(this, function () { return post('start', { target: 'tts' }) }, '语音服务启动中') }
  $('b-tts-stop').onclick = function () { act(this, function () { return post('stop', { target: 'tts' }) }, '语音服务已停止') }
  $('b-v-save').onclick = function () {
    var f = $('v-ref').value; if (!f) return toast('没有参考音频', true)
    act(this, function () { return post('voice/config', { refName: f, prompt_text: $('v-prompt').value.trim() }) }, '音色已应用')
  }
  $('b-v-upload').onclick = function () {
    var file = $('v-upload').files[0]
    if (!file) return toast('先选择音频文件', true)
    if (file.size > 30 * 1024 * 1024) return toast('音频不能超过 30MB', true)
    var status = $('v-upload-status'); var btn = this; btn.disabled = true; status.textContent = '上传中…'
    var qs = '?name=' + encodeURIComponent(file.name)
    file.arrayBuffer().then(function (buf) { return post('voice/upload' + qs, null, buf) }).then(function (r) {
      status.textContent = '上传完成，处理中…'
      return post('voice/prepare', { id: r.upload.id, startSec: Number($('v-start').value) || 0, durationSec: Number($('v-duration').value) || 6, removeMusic: $('v-remove-music').checked, promptText: $('v-upload-prompt').value.trim() })
    }).then(function (r) {
      var jid = r.job.id
      return new Promise(function (resolve, reject) {
        var n = 0
        var tick = function () { get('voice/job', { id: jid }).then(function (j) {
          if (j.job.status === 'done') return resolve(j.job)
          if (j.job.status === 'error') return reject(new Error(j.job.error || '预处理失败'))
          status.textContent = '处理中：' + (j.job.stage || '请稍候')
          if (++n > 240) return reject(new Error('处理超时'))
          setTimeout(tick, 1000)
        }).catch(reject) }
        tick()
      })
    }).then(function (job) {
      status.textContent = '完成：' + job.result.name + '（已选中，试听后点“应用所选音色”）'
      loadVoice().then(function () { $('v-ref').value = job.result.name; $('v-prompt').value = job.result.prompt_text || $('v-upload-prompt').value.trim(); $('v-ref').dispatchEvent(new Event('change')) })
    }).catch(function (e) { status.textContent = '失败：' + e.message; toast(e.message, true) }).finally(function () { btn.disabled = false })
  }

  // ── 表情包 ──
  function loadStickers() {
    get('stickers/stats').then(function (s) {
      $('st-stats').textContent = '共 ' + s.total + ' 张　正式 ' + (s.byLayer.library || 0) + ' · 候选 ' + (s.byLayer.candidate || 0) + ' · 回收 ' + (s.byLayer.trash || 0) + '　未打标 ' + s.untagged + '　10 分钟已发 ' + s.sendsLast10min
    })
    get('stickers/list', { layer: $('st-layer').value, q: $('st-q').value.trim(), n: 150 }).then(function (r) {
      $('st-grid').innerHTML = r.items.map(function (i) {
        return '<div class="sticker" data-id="' + i.id + '"><span class="layer">' + esc(i.layer) + '</span><img loading="lazy" src="' + API + 'stickers/file?id=' + i.id + '">' +
          '<div class="tags" title="' + esc(i.desc) + '">' + esc((i.tags || []).join(' ') || '（无标签）') + '</div>' +
          '<div class="tag-edit" hidden><input class="tag-input" value="' + esc((i.tags || []).join(',')) + '" placeholder="标签，用逗号分隔"><button data-a="tag-save">保存</button></div>' +
          '<div class="ops"><button data-a="send">发给主人</button><button data-a="tag">编辑标签</button><button data-a="' + (i.layer === 'trash' ? 'restore' : 'trash') + '">' + (i.layer === 'trash' ? '恢复' : '删除') + '</button></div></div>'
      }).join('') || '<div class="muted">没有匹配的表情包</div>'
      $('st-grid').querySelectorAll('.sticker').forEach(function (el) {
        el.querySelectorAll('button').forEach(function (b) {
          b.onclick = function () {
            var id = el.dataset.id, a = b.dataset.a
            if (a === 'send') act(b, function () { return post('stickers/send', { id: id, force: true }) }, '已发到 QQ')
            else if (a === 'trash') act(b, function () { return post('stickers/trash', { id: id }).then(loadStickers) }, '已放入回收站')
            else if (a === 'restore') act(b, function () { return post('stickers/restore', { id: id }).then(loadStickers) }, '已恢复')
            else if (a === 'tag') {
              var box = el.querySelector('.tag-edit')
              box.hidden = !box.hidden
              if (!box.hidden) el.querySelector('.tag-input').focus()
            } else if (a === 'tag-save') {
              var input = el.querySelector('.tag-input')
              var v = input.value.trim().split(/[\s,，]+/).filter(Boolean).join(',')
              act(b, function () { return post('stickers/set', { id: id, tags: v }).then(loadStickers) }, '标签已更新')
            }
          }
        })
      })
    })
  }
  $('b-st-go').onclick = loadStickers
  $('st-layer').onchange = loadStickers
  $('st-q').onkeydown = function (e) { if (e.key === 'Enter') loadStickers() }
  $('st-file').onchange = function () {
    var files = Array.prototype.slice.call(this.files); this.value = ''
    var tg = ($('st-upload-tags').value || '').trim().split(/[\s,，]+/).filter(Boolean).join(',')
    var chain = Promise.resolve(); var ok = 0
    files.forEach(function (f) {
      chain = chain.then(function () { return f.arrayBuffer() }).then(function (buf) {
        return post('stickers/upload?name=' + encodeURIComponent(f.name) + '&tags=' + encodeURIComponent(tg), null, buf)
      }).then(function () { ok++ }).catch(function (e) { toast(f.name + '：' + e.message, true) })
    })
    chain.then(function () { toast('已上传 ' + ok + ' 张'); loadStickers() })
  }

  // ── 人设 / 记忆 ──
  function loadDocs() {
    get('docs/list').then(function (r) {
      $('doc-list').innerHTML = r.docs.map(function (d) { return '<li data-n="' + esc(d.name) + '"><span>' + esc(d.name) + '</span><small>' + d.kb + 'K</small></li>' }).join('')
      $('doc-list').querySelectorAll('li').forEach(function (li) { li.onclick = function () { openDoc(li.dataset.n) } })
    })
  }
  function openDoc(n) {
    get('docs/read', { name: n }).then(function (r) {
      state.doc = n; $('doc-title').textContent = n; $('doc-edit').value = r.content; $('doc-edit').disabled = false; $('b-doc-save').disabled = false; $('doc-msg').textContent = ''
      $('doc-list').querySelectorAll('li').forEach(function (li) { li.classList.toggle('on', li.dataset.n === n) })
    }).catch(function (e) { toast(e.message, true) })
  }
  $('b-doc-save').onclick = function () {
    if (!state.doc) return
    act(this, function () { return post('docs/write', { name: state.doc, content: $('doc-edit').value }).then(function (r) { $('doc-msg').textContent = '已保存，备份：' + r.backup }) }, '已保存')
  }
  $('b-backup').onclick = function () { act(this, function () { return post('backup').then(function (r) { toast('已备份到 ' + r.dir) }) }) }

  // ── 限额 / 白名单 ──
  function loadParams() {
    get('params').then(function (r) {
      $('params').innerHTML = r.params.map(function (p) {
        return '<label>' + esc(p.label) + '</label>' + (p.type === 'bool'
          ? '<input type="checkbox" data-k="' + p.key + '"' + (p.value ? ' checked' : '') + '>'
          : '<input type="number" data-k="' + p.key + '" min="' + p.min + '" max="' + p.max + '" value="' + p.value + '">')
      }).join('')
      $('p-warning').value = r.socialWarning || ''
      $('al-users').value = (r.allow.users || []).join('\n'); $('al-groups').value = (r.allow.groups || []).join('\n')
    })
  }
  function collectParams() {
    var v = {}
    $('params').querySelectorAll('input').forEach(function (el) { v[el.dataset.k] = el.type === 'checkbox' ? el.checked : Number(el.value) })
    return v
  }
  $('b-params-save').onclick = function () { act(this, function () { return post('params', { values: collectParams(), socialWarning: $('p-warning').value }) }, '已保存（重启 AstrBot 后生效）') }
  $('b-params-restart').onclick = function () {
    act(this, function () { return post('params', { values: collectParams(), socialWarning: $('p-warning').value }).then(function () { return post('restart', { target: 'astrbot' }) }) }, '已保存并重启 AstrBot')
  }
  $('b-al-save').onclick = function () {
    var lines = function (id) { return $(id).value.split(/[\s,，]+/).filter(Boolean) }
    act(this, function () { return post('allowlist', { users: lines('al-users'), groups: lines('al-groups') }).then(function () { return post('restart', { target: 'astrbot' }) }) }, '白名单已保存，AstrBot 已重启')
  }

  // ── 计划任务 ──
  function fmt(t) { return t && t.indexOf('0001') !== 0 && t.indexOf('1999') !== 0 ? t.replace('T', ' ').slice(0, 16) : '—' }
  function loadTasks() {
    get('tasks').then(function (r) {
      $('task-table').querySelector('tbody').innerHTML = r.tasks.map(function (t) {
        var ok = t.result === 0 || t.result === 267011 || t.result === 267009
        return '<tr><td>' + esc(t.name) + '</td><td>' + esc(t.state) + '</td><td>' + fmt(t.last) + '</td><td style="color:var(' + (ok ? '--ok' : '--bad') + ')">' + t.result + '</td><td>' + fmt(t.next) + '</td>' +
          '<td><button data-a="run" data-n="' + esc(t.name) + '">立即运行</button> <button data-a="' + (t.state === 'Disabled' ? 'on' : 'off') + '" data-n="' + esc(t.name) + '">' + (t.state === 'Disabled' ? '启用' : '停用') + '</button></td></tr>'
      }).join('') || '<tr><td colspan="6" class="muted">没有 QQBot-* 计划任务</td></tr>'
      $('task-table').querySelectorAll('button').forEach(function (b) {
        b.onclick = function () {
          var a = b.dataset.a, n = b.dataset.n
          act(b, function () { return a === 'run' ? post('task/run', { name: n }) : post('task/enable', { name: n, enabled: a === 'on' }) }, '已执行').then(loadTasks)
        }
      })
    })
  }
  $('b-tasks').onclick = loadTasks

  // ── 日志（SSE 实时） ──
  var lines = []
  function fmtLine(r) {
    var d = new Date(r.t); var ts = d.toTimeString().slice(0, 8)
    return { html: '<span class="src ' + r.src + '">' + ts + ' ' + r.src + '</span> ' + esc(r.text) }
  }
  function renderLog() {
    var src = $('lg-src').value, f = $('lg-filter').value.trim().toLowerCase()
    var out = lines.filter(function (r) { return (src === 'all' || r.src === src) && (!f || r.text.toLowerCase().indexOf(f) >= 0) }).slice(-400)
    $('log').innerHTML = out.map(function (r) { return fmtLine(r).html }).join('\n')
    if ($('lg-follow').checked) $('log').scrollTop = $('log').scrollHeight
  }
  function startStream() {
    get('logs', { src: 'all', n: 300 }).then(function (r) { lines = r.lines || []; if (state.tab === 'logs') renderLog() })
    try {
      var es = new EventSource(API + 'logs/stream')
      es.onmessage = function (m) { try { lines.push(JSON.parse(m.data)); if (lines.length > 1500) lines.splice(0, 300); if (state.tab === 'logs') renderLog() } catch (e) {} }
    } catch (e) {}
  }
  $('lg-src').onchange = renderLog; $('lg-filter').oninput = renderLog
  $('b-lg-clear').onclick = function () { lines = []; renderLog() }

  // ── 设置 ──
  function loadSettings() {
    return get('settings').then(function (r) {
      state.settings = r
      $('s-root').value = r.raw.root || ''
      $('s-owner').value = r.raw.ownerQq || ''
      $('s-bot').value = r.raw.botQq || ''
      $('s-voicepy').value = r.raw.voicePy || ''
    })
  }
  $('b-settings-save').onclick = function () {
    var owner = $('s-owner').value.trim(), bot = $('s-bot').value.trim()
    if (owner && !/^\d{5,12}$/.test(owner)) return toast('主人 QQ 号格式不对', true)
    if (bot && !/^\d{5,12}$/.test(bot)) return toast('机器人 QQ 号格式不对', true)
    act(this, function () {
      return post('settings', { patch: { root: $('s-root').value.trim(), ownerQq: owner, botQq: bot, voicePy: $('s-voicepy').value.trim() } })
        .then(function () { $('settings-msg').textContent = '已保存' })
    }, '设置已保存')
  }

  // ── 启动 ──
  refresh(); loadDiag(); loadCfg(); loadSettings(); startStream()
  setInterval(function () { if (!document.hidden) refresh() }, state.tab === 'login' ? 2000 : 4000)
  setInterval(function () { if (!document.hidden && state.tab === 'login') refresh() }, 2000)
  setInterval(function () { if (!document.hidden && state.tab === 'overview') loadDiag() }, 20000)
})()
