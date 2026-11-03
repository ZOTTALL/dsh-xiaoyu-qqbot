// Local, evidence-backed memory projection. No model or cloud calls in local mode.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { createSemanticIndex } from './memory-semantic.mjs'
import '../assets/memory-brain.js'
const brain=globalThis.QQBotBrain

const hash = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 20)
const MAX_FILE = 512 * 1024
const MAX_FILES = 2000
const MAX_UNITS = 3000
const aliases = new Map([['机器人', '机器人'], ['主人', '主人'], ['deepseek', 'DeepSeek'], ['astrbot', 'AstrBot'], ['napcat', 'NapCat'], ['dsh', 'DSH'], ['qq', 'QQ'], ['redis', 'Redis'], ['mongodb', 'MongoDB'], ['gpt-sovits', 'GPT-SoVITS']])
const vocabulary = ['主人', '机器人', '示例主食', '零食', '表情包', '语音', '记忆', '动画', '电视剧', '实验', '作息', '偏好', '风控', '课程', '机器学习', '分布式', '考试', '比赛', '吃饭', '睡觉', '约定', '承诺', '助手', '默认形象', '语气', '人格', '头歌', '示例音色', '原神', 'Hindsight', 'DeepSeek', 'AstrBot', 'NapCat', 'DSH', 'QQ', 'Redis', 'MongoDB', 'GPT-SoVITS', 'Python', 'Windows', 'SQLite', 'FTS5']
const stop = new Set(['今天','现在','可以','不能','没有','自己','我们','你们','这个','那个','已经','以后','之前','因为','所以','然后','一个','一些','时候','每次','不是','还是','这样','什么','怎么','不要','必须','需要','默认','当前','允许','禁止','最多','开始','继续','通过','直接','只有','不用','不再','来源','原文','记录','回复','消息','内容','方式','使用','功能','情况','作为','相关','实际','每个','一次','两次','分钟','小时','文件','目录','路径','参数','命令','规则','信息','包括','进行','完成','支持','新增','保持','修改','应该','能够','根据','以及','或者','其他','同时','不是','而是','之间','上次','最近','之后','要求','关于','一条','的话','结果','问题','本次','当时','条目','正常','记住'])
const segmenter = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter('zh', { granularity: 'word' }) : null

function clean(text) {
  return String(text).replace(/<!--[^]*?-->/g, '').replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, '[密钥已隐藏]').replace(/((?:api[_-]?key|password|token|secret)\s*[:=]\s*)[^\s,;，。]{8,}/gi, '$1[已隐藏]')
}
function terms(text) {
  const found = new Set()
  for (const word of vocabulary) if (/[A-Za-z]/.test(word) ? new RegExp(`(?<![A-Za-z0-9])${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9])`, 'i').test(text) : text.includes(word)) found.add(aliases.get(word.toLowerCase()) || word)
  if (segmenter) for (const part of segmenter.segment(text)) {
    const word = part.segment
    if (part.isWordLike && /^[\u4e00-\u9fff]{2,6}$/.test(word) && !stop.has(word)) found.add(aliases.get(word) || word)
  }
  for (const word of text.match(/\b[A-Za-z][A-Za-z0-9_-]{2,22}\b/g) || []) {
    if (/^(?:https?|localhost|true|false|null|json|send|file|path|tags|desc|source|layer|candidate|library|trash|token|password|system|prompt|memory|daily|surprise)$/i.test(word)) continue
    found.add(aliases.get(word.toLowerCase()) || word)
  }
  return [...found].slice(0, 45)
}

export function createMemoryStore({ root, clock = () => Date.now(), fetcher = globalThis.fetch, semanticConfig, workspace: workspaceOption, memoryDir: memoryDirOption } = {}) {
  const semantic=createSemanticIndex({root,workspace:workspaceOption||path.join(root,'workspace'),config:semanticConfig})
  const workspace = workspaceOption || path.join(root, 'workspace')
  const mem = memoryDirOption || path.join(workspace, 'memory')
  const settingsFile = path.join(workspace, 'data', 'memory-v2.settings.json')
  let cached = null; let checked = 0
  let cursor = 0; const events = []; const listeners = new Set(); let timer = null

  function settings() {
    let v = {}
    try { v = JSON.parse(fs.readFileSync(settingsFile, 'utf8')) } catch {}
    return { url: String(process.env.QQBOT_HINDSIGHT_URL || v.url || ''), bank: String(process.env.QQBOT_HINDSIGHT_BANK || v.bank || 'qqbot-owner') }
  }
  function validateEngine(url, bank) {
    if (!/^[A-Za-z0-9_.:-]{1,100}$/.test(bank)) throw new Error('记忆库名称无效')
    if (!url) return ''
    const u = new URL(url)
    if (!['http:', 'https:'].includes(u.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname) || u.username || u.password || u.search || u.hash || !['', '/'].includes(u.pathname)) throw new Error('自托管地址须为本机 HTTP(S) 服务根地址')
    return u.origin
  }
  function configure(input) {
    const bank = String(input.bank || 'qqbot-owner'); const url = validateEngine(String(input.url || '').trim(), bank)
    fs.mkdirSync(path.dirname(settingsFile), { recursive: true })
    const tmp = settingsFile + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify({ url, bank }, null, 2), 'utf8'); fs.renameSync(tmp, settingsFile)
    emit('engine.changed', { configured: !!url }); return { ok: true, url, bank }
  }
  function emit(type, payload) {
    const event = { cursor: ++cursor, type, at: new Date(clock()).toISOString(), ...payload }
    events.push(event); if (events.length > 100) events.shift()
    for (const listener of listeners) { try { listener(event) } catch {} }
  }
  function files() {
    const rows = []; const warnings = []
    function walk(dir, depth) {
      if (depth > 4 || rows.length >= MAX_FILES) return
      let entries
      try { entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name)) } catch (e) { if (dir !== mem) warnings.push('目录暂不可读：' + path.relative(mem, dir)); return }
      for (const e of entries) {
        if (e.name.startsWith('.') || e.isSymbolicLink()) continue
        const fp = path.join(dir, e.name)
        if (e.isDirectory()) walk(fp, depth + 1)
        else if (e.isFile() && /\.md$/i.test(e.name)) {
          const stat = fs.statSync(fp)
          if (stat.size > MAX_FILE) { warnings.push('已跳过超大文件：' + e.name); continue }
          const relative = path.relative(mem, fp).replace(/\\/g, '/')
          const raw = fs.readFileSync(fp, 'utf8')
          rows.push({ path: relative, text: clean(raw), digest: hash(raw), mtime: stat.mtimeMs, scope: relative.startsWith('stranger-chat/') ? 'stranger' : 'owner' })
          if (rows.length >= MAX_FILES) break
        }
      }
    }
    walk(mem, 0)
    if (rows.length >= MAX_FILES) warnings.push('已达 2000 文件上限')
    return { rows, warnings }
  }
  function scan(force = false) {
    if (!force && cached && clock() - checked < 2000) return cached
    checked = clock()
    const { rows, warnings } = files()
    const revision = hash(rows.map(r => `${r.path}:${r.digest}`).join('|'))
    if (cached?.revision === revision) return cached
    const units = []
    for (const file of rows) {
      let line = 1; let section = ''; let paragraph = []; let start = 1
      const occurrences = new Map()
      function flush() {
        const text = paragraph.join('\n').trim(); paragraph = []
        if (!text || units.length >= MAX_UNITS) return
        if(text.includes('{{')||/^>\s*(?:这是空白占位文件|文件名为虚构示例日期)/.test(text))return
        const duplicate = occurrences.get(text) || 0; occurrences.set(text, duplicate + 1)
        const match = file.path.match(/(?:^|\/)(\d{4}-\d{2}-\d{2})\.md$/)
        const day = match?.[1] || null
        const category = /^(?:lore|sticker-notes)\.md$/.test(file.path) ? 'knowledge' : file.path === 'soul.md' ? 'persona' : /^(?:user|facts)\.md$/.test(file.path) ? 'fact' : 'experience'
        units.push({ id: 'm-' + hash(file.path + '\0' + text + '\0' + duplicate), type: 'memory', label: text.replace(/^[#\-*\s]+/, '').split('\n')[0].slice(0, 62), text, source: file.path, line: start, section, scope: file.scope, category, day, time: day ? day + 'T12:00:00+08:00' : null, updatedAt: new Date(file.mtime).toISOString(), timeBasis: day ? 'journal-date' : 'file-modified', entities: terms(text) })
      }
      for (const row of file.text.split(/\r?\n/)) {
        if (/^#{1,6}\s/.test(row)) { flush(); section = row.replace(/^#+\s*/, '') }
        else if (!row.trim()) flush()
        else { if (/^\s*(?:[-*]\s|\d+[.)、]\s)/.test(row) && paragraph.length) flush(); if (!paragraph.length) start = line; paragraph.push(row); if (paragraph.join('\n').length >= 1500) flush() }
        line++
      }
      flush()
    }
    for (const unit of units) Object.assign(unit,brain.classify(unit.text))
    if (units.length >= MAX_UNITS) warnings.push('已达 3000 片段上限；请按范围缩小来源')
    const previous = cached?.revision
    cached = { revision, units, sources: rows.map(({text, ...r}) => r), warnings, scannedAt: new Date(clock()).toISOString() }
    if (previous) emit('memory.changed', { revision, memories: units.length, files: rows.length })
    return cached
  }
  function filtered(options = {}) {
    const scope = options.scope || 'owner'
    if (!['owner','stranger','all'].includes(scope)) throw new Error('未知记忆范围')
    const date = value => { if (!value) return null; if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value))) throw new Error('日期格式应为 YYYY-MM-DD'); return value }
    const from = date(options.from); const to = date(options.to)
    if (from && to && from > to) throw new Error('开始日期晚于结束日期')
    const q = String(options.q || '').trim().toLocaleLowerCase().slice(0, 200)
    return scan().units.filter(u => (scope === 'all' || u.scope === scope) && (!options.category || u.category === options.category) && (!q || (u.text + ' ' + u.source).toLocaleLowerCase().includes(q)) && (!from || u.day && u.day >= from) && (!to || u.day && u.day <= to))
  }
  function graph(options = {}) {
    if (options.view && !['entities','memories'].includes(options.view)) throw new Error('未知图谱视图')
    const all = filtered(options)
    const cap = Math.min(600, Math.max(10, Number(options.limit) || 180))
    const selected = options.focus || ''
    const counts = new Map(); const links = new Map()
    for (const unit of all) for (const name of unit.entities) {
      const row = counts.get(name) || { name, memories: [], at: unit.time || unit.updatedAt }
      row.memories.push(unit.id); if ((unit.time || unit.updatedAt) > row.at) row.at = unit.time || unit.updatedAt
      counts.set(name, row)
    }
    const vocabularySet = new Set(vocabulary.map(x => aliases.get(x.toLowerCase()) || x))
    const eligibleRows = [...counts.values()].filter(r => r.memories.length >= 2 || vocabularySet.has(r.name)).sort((a,b) => b.memories.length-a.memories.length || a.name.localeCompare(b.name))
    const entityRows = eligibleRows.slice(0, cap)
    let nodes = entityRows.map(r => ({ id: 'e-' + hash(r.name), type: 'entity', label: r.name, count: r.memories.length, at: r.at, memoryIds: r.memories }))
    const included = new Map(nodes.map(n => [n.label, n]))
    if (options.view === 'memories') {
      const visible = all.slice(0, Math.min(180, cap))
      const ids = new Set(visible.map(u => u.id))
      nodes = nodes.slice(0, 70).filter(n => n.memoryIds.some(id => ids.has(id)))
      const entityIds = new Set(nodes.map(n => n.id))
      for (const unit of visible) {
        nodes.push({ id: unit.id, type: 'memory', label: unit.label, count: 1, at: unit.time || unit.updatedAt, category: unit.category })
        for (const name of unit.entities) { const n = included.get(name); if (n && entityIds.has(n.id)) links.set(unit.id + n.id, { id: hash(unit.id+n.id), source: unit.id, target: n.id, type: 'mentions', weight: 1 }) }
      }
    } else {
      const min = Math.max(1, Math.min(30, Number(options.minCount) || 1))
      for (const unit of all) {
        const ns = unit.entities.map(x => included.get(x)).filter(Boolean).slice(0, 18)
        for (let i=0;i<ns.length;i++) for (let j=i+1;j<ns.length;j++) {
          const [a,b] = [ns[i].id,ns[j].id].sort(); const key = a+':'+b
          const edge = links.get(key) || { id: hash(key), source: a, target: b, type: 'cooccurrence', weight: 0 }
          edge.weight++; links.set(key, edge)
        }
      }
      for (const [key, edge] of links) if (edge.weight < min) links.delete(key)
    }
    let edges = [...links.values()].sort((a,b) => b.weight-a.weight || a.id.localeCompare(b.id)).slice(0, 2500)
    if (selected) {
      const related = new Set([selected]); for (const e of edges) if (e.source === selected || e.target === selected) { related.add(e.source); related.add(e.target) }
      nodes = nodes.filter(n => related.has(n.id)); edges = edges.filter(e => related.has(e.source) && related.has(e.target))
    }
    for (const node of nodes) {
      const linked=all.filter(u=>u.id===node.id||node.memoryIds?.includes(u.id))
      const votes=new Map(); for(const unit of linked) votes.set(unit.region,(votes.get(unit.region)||0)+1)
      const direct=brain.classify(node.label); if(direct.tags.some(t=>t!=='episodic')){node.region=direct.region}else node.region=[...votes].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0]))[0]?.[0]||brain.classify(node.label).region
      node.regionBasis='rules-v1 / source-majority'
    }
    const nodeIds = new Set(nodes.map(n => n.id)); edges = edges.filter(e => nodeIds.has(e.source) && nodeIds.has(e.target))
    return { engine: 'local-evidence', semantic: false, regions:brain.regions.map(({pattern,...r})=>r), bundles:brain.bundles(nodes,edges), revision: scan().revision, nodes, edges, stats: { memories: all.length, files: new Set(all.map(u=>u.source)).size, entities: eligibleRows.length, shownNodes: nodes.length, shownEdges: edges.length, truncated: eligibleRows.length > cap || links.size > 2500 || options.view === 'memories' && all.length > Math.min(180,cap) }, warnings: scan().warnings, scannedAt: scan().scannedAt }
  }
  function detail(id, options = {}) {
    const units = filtered(options)
    const unit = units.find(u => u.id === id)
    if (unit) return { kind: 'memory', item: unit }
    const matching = units.filter(u => u.entities.some(name => 'e-'+hash(name) === id))
    if (!matching.length) throw new Error('该记忆已更新或不在当前范围')
    const name = matching[0].entities.find(name => 'e-'+hash(name) === id)
    return { kind: 'entity', item: { id, label: name, count: matching.length }, memories: matching.slice(0, 80), truncated: matching.length > 80 }
  }
  function recall(query, options = {}) {
    const q = String(query || '').trim().slice(0, 300)
    if (!q) return { engine: 'local-evidence', semantic: false, query: q, results: [] }
    const words = terms(q)
    const results = filtered({ ...options, q:'', scope: options.scope || 'owner' }).map(unit => {
      const lower = unit.text.toLowerCase()
      const exact = lower.includes(q.toLowerCase())
      const hits = words.filter(w => lower.includes(w.toLowerCase()))
      return { ...unit, score: (exact ? 10 : 0) + hits.length, match: exact ? '原文包含查询' : '命中词：' + hits.join('、') }
    }).filter(r => r.score > 0).sort((a,b) => b.score-a.score || b.updatedAt.localeCompare(a.updatedAt)).slice(0, Math.min(20,Math.max(1, Number(options.limit)||8)))
    return { engine: 'local-evidence', semantic: false, query: q, results, note: '本地原文/实体词检索，不是向量语义召回，也不是生成回答。' }
  }
  async function hybridRecall(query, options={}) {
    const snapshot=scan(true)
    const allowed=filtered({...options,q:''})
    if(!String(query||'').trim())return {engine:'local-hybrid',semantic:true,query:'',results:[],note:'请输入查询。'}
    try {return await semantic.recall(String(query).slice(0,300),{scope:options.scope||'owner',limit:options.limit||8,budget:options.budget||5000},snapshot,allowed)}
    catch(e) {return {...recall(query,options),degraded:true,error:e.message,note:'向量索引暂不可用；当前仅返回词项检索证据。'}}
  }
  async function reflect(query,options={}) {
    const recall=await hybridRecall(query,{...options,limit:12,budget:7000})
    const evidence=recall.results.slice().sort((a,b)=>(a.time||a.updatedAt).localeCompare(b.time||b.updatedAt))
    return {...recall,results:evidence,mode:'extractive-evidence-review',generated:false,observations:evidence.map(u=>({id:u.id,source:u.source,line:u.line,day:u.day,text:u.text})),note:'证据回顾：按已知日期/文件更新时间展示原文，不推断冲突优先级，不覆盖事实；不是 Hindsight 生成式 Reflect。'}
  }
  function startIndex(){semantic.schedule(scan,()=>{})}
  function retain(input) {
    const text = String(input.text || '').trim()
    if (!text || text.length > 6000) throw new Error('记忆正文须为 1–6000 字')
    if (clean(text) !== text) throw new Error('正文含疑似密钥字段，请先移除')
    const id = crypto.randomUUID(); const dir = path.join(mem, 'notes'); fs.mkdirSync(dir, { recursive: true })
    const day = new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(clock()))
    const file = path.join(dir, day+'-'+id+'.md')
    fs.writeFileSync(file, `# 人工记忆 · ${day}\n\n${text}\n`, { encoding:'utf8',flag:'wx' })
    scan(true); emit('memory.retained', { source: 'notes/'+path.basename(file), revision: cached.revision })
    return { ok:true, source:'notes/'+path.basename(file), message:'已保存原文；可由现有 memory 搜索读取。' }
  }
  function subscribe(listener, after = 0) {
    scan(); listeners.add(listener)
    if (after > 0 && events.length && after >= events[0].cursor-1 && after <= cursor) { for (const event of events) if (event.cursor > after) listener(event) }
    else listener({ cursor, type:'snapshot', revision:cached.revision, at:new Date(clock()).toISOString() })
    if (!timer) { timer = setInterval(() => { try { scan(true) } catch (e) { emit('memory.error',{ error:e.message }) } }, 3000); timer.unref?.() }
    return () => { listeners.delete(listener); if (!listeners.size && timer) { clearInterval(timer); timer=null } }
  }
  async function remote(endpoint, { method='GET', body, timeout=4500 } = {}) {
    const cfg=settings(); const url=validateEngine(cfg.url,cfg.bank)
    if (!url) throw new Error('尚未配置自托管 Hindsight')
    const response=await fetcher(url+endpoint.replace('{bank}',encodeURIComponent(cfg.bank)),{ method, redirect:'error',headers:{'content-type':'application/json',...(process.env.QQBOT_HINDSIGHT_TOKEN ? {authorization:'Bearer '+process.env.QQBOT_HINDSIGHT_TOKEN}: {})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(timeout) })
    if (!response.ok) throw new Error('Hindsight HTTP '+response.status)
    return response.json()
  }
  async function engine() {
    const cfg=settings()
    if (!cfg.url) return { configured:false,connected:false,mode:'local-evidence',bank:cfg.bank,cloud:false }
    try { await remote('/health'); return {configured:true,connected:true,mode:'hindsight-self-hosted',url:cfg.url,bank:cfg.bank,cloud:false} }
    catch (e) { return {configured:true,connected:false,mode:'local-evidence',url:cfg.url,bank:cfg.bank,error:e.message,cloud:false} }
  }
  async function hindsightGraph(view) {
    if (!['entities','memories'].includes(view)) throw new Error('未知图谱视图')
    const raw = await remote(`/v1/default/banks/{bank}/${view === 'entities' ? 'entities/graph' : 'graph'}?limit=500`)
    const nodes=(Array.isArray(raw.nodes)?raw.nodes:[]).slice(0,500).map(n=>{const d=n.data||n;return {id:String(d.id),label:String(d.label||d.text||d.id).slice(0,100),type:view==='entities'?'entity':'memory',count:Number(d.mentionCount||1),at:d.lastSeen||null,text:d.text||''}})
    const ids=new Set(nodes.map(n=>n.id))
    const edges=(Array.isArray(raw.edges)?raw.edges:[]).slice(0,2500).map(e=>{const d=e.data||e;return {id:String(d.id||hash(d.source+':'+d.target)),source:String(d.source),target:String(d.target),type:String(d.linkType||'related'),weight:Number(d.weight||1)}}).filter(e=>ids.has(e.source)&&ids.has(e.target))
    return { engine:'hindsight-self-hosted',semantic:true,nodes,edges,revision:hash(JSON.stringify(raw)),stats:{memories:raw.total_units||0,files:0,entities:raw.total_entities||nodes.length,shownNodes:nodes.length,shownEdges:edges.length,truncated:(raw.total_edges||0)>edges.length},warnings:['来自专用自托管 bank；未自动上传本地记忆。'],scannedAt:new Date(clock()).toISOString() }
  }
  function status() { const data=scan(); return {engine:'local-evidence',revision:data.revision,files:data.sources.length,memories:data.units.length,scopeCounts:{owner:data.units.filter(u=>u.scope==='owner').length,stranger:data.units.filter(u=>u.scope==='stranger').length},warnings:data.warnings,scannedAt:data.scannedAt,subscribers:listeners.size,localIndex:semantic.status()} }
  function dispose() { const stopped=semantic.dispose(); if(timer) clearInterval(timer);timer=null;listeners.clear();return stopped }
  function items(options = {}) {
    const limit = Math.min(200, Math.max(1, Number(options.limit) || 80))
    return filtered(options).sort((a,b) => (b.time || b.updatedAt).localeCompare(a.time || a.updatedAt)).slice(0,limit)
  }
  return { graph, detail, recall, hybridRecall, reflect, startIndex, syncIndex:()=>semantic.sync(scan(true)), retain, items, subscribe, status, configure, settings, engine, hindsightGraph, scan, dispose }
}
