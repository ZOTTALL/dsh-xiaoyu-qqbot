import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import {createScheduler,lineSink,streamCommand,downloadChecked,powershellArgs,commandError,publishDirectory,quotePS} from '../lib/deploy-utils.mjs'
import {ensureTools} from '../lib/deploy-tools.mjs'
const digest=bytes=>crypto.createHash('sha256').update(bytes).digest('hex')
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve}}
function temp(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),"qqbot tools user's "));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root}

test('Windows publication: transient executable handle lock is retried, unrelated errors preserved',async()=>{
 let attempts=0,waits=0
 await publishDirectory('source','target',{rename:async()=>{if(++attempts<3)throw Object.assign(new Error('busy'),{code:'EPERM'})},delay:async()=>{waits++}})
 assert.equal(attempts,3);assert.equal(waits,2)
 await assert.rejects(publishDirectory('source','target',{rename:async()=>{throw Object.assign(new Error('existing target'),{code:'EEXIST'})},delay:()=>{throw new Error('unexpected retry')}}),/existing target/)
})

test('deploy scheduler: repeated component requests return one running job',async()=>{
 const s=createScheduler(),gate=deferred();let calls=0
 const a=s.start('napcat','fixture',async()=>{calls++;await gate.promise}),b=s.start('napcat','fixture',()=>{calls++})
 assert.equal(a.id,b.id);assert.equal(b.reused,true);gate.resolve();await s.get(a.id).promise;assert.equal(calls,1);assert.equal(s.view(a.id).status,'done');assert.equal(s.view(a.id).promise,undefined)
})
test('deploy scheduler: same-root components serialize, other roots do not block',async()=>{
 const s=createScheduler(),gate=deferred(),events=[]
 const a=s.start('astrbot','one',async()=>{events.push('a');await gate.promise;events.push('a-done')})
 const b=s.start('bridge','one',()=>events.push('b')),c=s.start('astrbot','two',()=>events.push('c'))
 await s.get(c.id).promise;assert.deepEqual(events,['a','c']);gate.resolve();await s.get(b.id).promise;assert.deepEqual(events,['a','c','a-done','b']);await s.get(a.id).promise
})
test('deploy scheduler: aggregate may await component without deadlock and reuses manual job',async()=>{
 const s=createScheduler(),gate=deferred();let calls=0
 const first=s.start('napcat','root',async()=>{calls++;await gate.promise})
 const all=s.start('all','root',async()=>{const child=s.start('napcat','root',()=>calls++);assert.equal(child.id,first.id);await s.get(child.id).promise},{queued:false})
 await Promise.resolve();gate.resolve();await s.get(all.id).promise;assert.equal(calls,1)
})
test('deploy scheduler: failure releases root queue and retry gets a new job',async()=>{
 const s=createScheduler(),a=s.start('tools','root',()=>{throw new Error('fixture error')}),b=s.start('napcat','root',()=>{})
 await s.get(b.id).promise;assert.equal(s.view(a.id).error,'fixture error');assert.equal(s.view(b.id).status,'done');assert.notEqual(s.start('tools','root',()=>{}).id,a.id)
})
test('UTF-8 logs: multibyte characters split into single bytes survive intact',()=>{
 const lines=[],sink=lineSink(s=>lines.push(s));for(const x of Buffer.from('请先准备 uv\r\n检查完成\n最后一行'))sink.write(Buffer.from([x]));sink.end();assert.deepEqual(lines,['请先准备 uv','检查完成','最后一行'])
})
test('process logs: stdout/stderr drain before completion and retain failure details',async()=>{
 const lines=[],r=await streamCommand(process.execPath,['-e',"process.stdout.write('部署工具正常\\n');process.stderr.write('下载连接失败');process.exitCode=7"],{step:s=>lines.push(s)})
 assert.equal(r.code,7);assert.ok(lines.includes('部署工具正常'));assert.match(commandError('tool',r),/下载连接失败/)
})
test('process logs: ENOENT is retained instead of generic source failure',async()=>{
 const r=await streamCommand('qqbot-tool-not-installed-xyz',[]);assert.equal(r.code,'ENOENT');assert.match(commandError('git',r),/找不到部署工具 git/)
})
test('PowerShell: real thrown Chinese error remains readable with nonzero exit',async()=>{
 if(process.platform!=='win32')return
 const ps=path.join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe')
 const r=await streamCommand(ps,powershellArgs("throw '缺少 uv，请检查部署工具'"));assert.equal(r.ok,false);assert.match(r.tail,/缺少 uv，请检查部署工具/)
})
test('PowerShell: complete setup script parses in Windows PowerShell 5.1',async()=>{
 if(process.platform!=='win32')return
 const ps=path.join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe')
 const file=path.resolve('tools/setup-memory.ps1')
 const r=await streamCommand(ps,powershellArgs(`$tokens=$null; $errors=$null; [System.Management.Automation.Language.Parser]::ParseFile(${quotePS(file)},[ref]$tokens,[ref]$errors) | Out-Null; if($errors.Count){throw $errors[0]}; Write-Output 'SETUP_SCRIPT_PARSE=PASS'`))
 assert.equal(r.ok,true,r.tail);assert.match(r.tail,/SETUP_SCRIPT_PARSE=PASS/)
})
test('PowerShell: clean PATH and foreign PSModulePath still find native hash/JSON cmdlets',async t=>{
 if(process.platform!=='win32')return
 const root=temp(t),file=path.join(root,'fixture.txt');fs.writeFileSync(file,'fixture')
 const env={...process.env};for(const k of Object.keys(env))if(k.toLowerCase()==='path')delete env[k]
 env.PATH=process.env.SystemRoot+'\\System32';env.PSModulePath=path.join(root,'empty-modules')
 const ps=path.join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe')
 const r=await streamCommand(ps,powershellArgs(`@{hash=(Get-FileHash -LiteralPath ${quotePS(file)} -Algorithm SHA256).Hash.ToLower()} | ConvertTo-Json -Compress`),{env})
 assert.equal(r.ok,true,r.tail);assert.equal(JSON.parse(r.tail).hash,digest('fixture'))
})
test('PowerShell: explicit UTF-8 output survives a real Windows PowerShell 5.1 child',async()=>{
 if(process.platform!=='win32')return
 const lines=[],ps=path.join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe')
 const r=await streamCommand(ps,powershellArgs("Write-Output '部署工具准备完成：中文不乱码'"),{step:s=>lines.push(s)});assert.equal(r.ok,true);assert.deepEqual(lines,['部署工具准备完成：中文不乱码'])
})
test('download: validated content is published and valid cache does not redownload',async t=>{
 const root=temp(t),dst=path.join(root,'cache.zip'),bytes=Buffer.from('verified fixture');let calls=0
 const fetcher=async()=>{calls++;return new Response(bytes)}
 await downloadChecked('https://example.test/file',dst,digest(bytes),{fetcher});await downloadChecked('https://example.test/file',dst,digest(bytes),{fetcher});assert.equal(calls,1);assert.deepEqual(fs.readFileSync(dst),bytes)
})
test('download: wrong hash preserves old file and cleans its unique part file',async t=>{
 const root=temp(t),dst=path.join(root,'cache.zip');fs.writeFileSync(dst,'old user file')
 await assert.rejects(downloadChecked('https://example.test/file',dst,digest('correct'),{fetcher:async()=>new Response('wrong')}),/SHA256/)
 assert.equal(fs.readFileSync(dst,'utf8'),'old user file');assert.deepEqual(fs.readdirSync(root),['cache.zip'])
})
test('download: interrupted body cleans partial content and returns actual error',async t=>{
 const root=temp(t),dst=path.join(root,'cache.zip')
 await assert.rejects(downloadChecked('https://example.test/file',dst,digest('correct'),{fetcher:async()=>new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array([1]));c.error(new Error('fixture disconnected'))}}))}),/fixture disconnected/)
 assert.deepEqual(fs.readdirSync(root),[])
})
test('download: bounded redirects reject HTTPS downgrade',async t=>{
 const root=temp(t);await assert.rejects(downloadChecked('https://example.test/file',path.join(root,'file.zip'),digest('x'),{fetcher:async()=>new Response(null,{status:302,headers:{location:'http://example.test/file'}})}),/非 HTTPS/)
 assert.deepEqual(fs.readdirSync(root),[])
})
test('download: HTTP failure creates no published or partial file',async t=>{
 const root=temp(t);await assert.rejects(downloadChecked('https://example.test/file',path.join(root,'file.zip'),digest('x'),{fetcher:async()=>new Response('no',{status:503})}),/HTTP 503/);assert.deepEqual(fs.readdirSync(root),[])
})
test('download: transient TLS/network reset is retried and reported without skipping hash',async t=>{
 const root=temp(t),data=Buffer.from('recovered');let calls=0;const retries=[]
 await downloadChecked('https://example.test/file',path.join(root,'file.zip'),digest(data),{fetcher:async()=>{if(++calls===1)throw Object.assign(new Error('fetch failed'),{cause:{code:'ECONNRESET'}});return new Response(data)},onRetry:(n,why)=>retries.push([n,why])})
 assert.equal(calls,2);assert.deepEqual(retries,[[1,'ECONNRESET']])
})
test('download: parallel unique destinations never share a temporary archive',async t=>{
 const root=temp(t),bytes=Buffer.from('archive'),seen=[]
 await Promise.all(['one','two'].map(n=>downloadChecked('https://example.test/'+n,path.join(root,n+'.zip'),digest(bytes),{fetcher:async url=>{seen.push(url);return new Response(bytes)}})))
 assert.equal(seen.length,2);assert.deepEqual(fs.readdirSync(root).sort(),['one.zip','two.zip'])
})
test('download: validated HTTP ranges are assembled contiguously then hashed',async t=>{
 const root=temp(t),dst=path.join(root,'range.zip'),bytes=Buffer.from('onetwo');let calls=0
 await downloadChecked('https://example.test/file',dst,digest(bytes),{fetcher:async(url,options)=>{
  const offset=calls++*3;assert.ok(options.headers.Range.startsWith('bytes='+offset+'-'))
  return new Response(bytes.subarray(offset,offset+3),{status:206,headers:{'content-range':`bytes ${offset}-${offset+2}/6`}})
 }});assert.equal(calls,2);assert.deepEqual(fs.readFileSync(dst),bytes)
})
test('download: inconsistent HTTP range is rejected before publication',async t=>{
 const root=temp(t);await assert.rejects(downloadChecked('https://example.test/file',path.join(root,'range.zip'),digest('x'),{fetcher:async()=>new Response('x',{status:206,headers:{'content-range':'bytes 1-1/2'}})}),/分段范围/);assert.deepEqual(fs.readdirSync(root),[])
})
test('tools: existing system tools are reused without download or process PATH mutation',async t=>{
 const root=temp(t),before={...process.env},env={PATH:'fixture',SystemRoot:'C:\\Windows'}
 const r=await ensureTools({root,env,run:async file=>({ok:true,stdout:file+' fixture version'}),download:()=>{throw new Error('unexpected network')}})
 assert.deepEqual(r.tools,{git:'git',uv:'uv'});assert.equal(r.env.PATH,'fixture');assert.ok(Object.keys(before).length===Object.keys(process.env).length&&Object.keys(before).every(k=>before[k]===process.env[k]),'process environment mutated');assert.equal(env.UV_CACHE_DIR,undefined)
})
function fakeRun(file,args){
 if(file==='git'||file==='uv')return Promise.resolve({ok:false,code:'ENOENT',stdout:''})
 if(file.endsWith('powershell.exe')){
  const stage=args.at(-1).match(/-DestinationPath '((?:''|[^'])*)'/)[1].replaceAll("''", "'")
  fs.mkdirSync(path.join(stage,'cmd'),{recursive:true});fs.writeFileSync(path.join(stage,'cmd/git.exe'),'fixture');fs.writeFileSync(path.join(stage,'uv.exe'),'fixture')
 }
 return Promise.resolve({ok:true,stdout:'fixture version'})
}
test('tools: missing Git/uv prepare pinned private tools, child PATH only; next call reuses them',async t=>{
 const root=temp(t),before={...process.env};let downloads=0
 const opts={root,env:{PATH:'',SystemRoot:'C:\\Windows'},platform:'win32',arch:'x64',run:fakeRun,download:async(url,dst,hash)=>{assert.match(url,/^https:\/\/github.com\/(git-for-windows\/git|astral-sh\/uv)\/releases\/download\//);assert.match(hash,/^[a-f0-9]{64}$/);downloads++}}
 const r=await ensureTools(opts);assert.ok(r.tools.git.startsWith(root));assert.ok(r.tools.uv.startsWith(root));assert.ok(r.env.PATH.includes('.deploy-tools'));assert.ok(r.env.UV_PYTHON_INSTALL_DIR.startsWith(root));await ensureTools(opts);assert.equal(downloads,2);assert.ok(Object.keys(before).length===Object.keys(process.env).length&&Object.keys(before).every(k=>before[k]===process.env[k]),'process environment mutated')
})
test('tools: concurrent bootstrap calls share one download and atomic install',async t=>{
 const root=temp(t);let downloads=0
 const opts={root,names:['uv'],env:{PATH:''},platform:'win32',arch:'x64',run:fakeRun,download:async()=>{downloads++;await new Promise(r=>setTimeout(r,10))}}
 const [a,b]=await Promise.all([ensureTools(opts),ensureTools(opts)]);assert.equal(a.tools.uv,b.tools.uv);assert.equal(downloads,1)
})
test('tools: unsupported architecture is explicit and does not attempt random executable',async t=>{
 await assert.rejects(ensureTools({root:temp(t),names:['git'],platform:'win32',arch:'fixture',run:fakeRun}),/未提供便携 git/)
})
test('tools: failed verified download never publishes an incomplete tool',async t=>{
 const root=temp(t);await assert.rejects(ensureTools({root,names:['uv'],env:{PATH:''},platform:'win32',arch:'x64',run:fakeRun,download:async()=>{throw new Error('SHA256 fixture failure')}}),/SHA256/)
 assert.ok(!fs.existsSync(path.join(root,'.deploy-tools','uv-0.13.7-x64')))
})
test('tools: symlinked tool root is rejected before extraction',async t=>{
 const root=temp(t),elsewhere=temp(t);fs.symlinkSync(elsewhere,path.join(root,'.deploy-tools'),process.platform==='win32'?'junction':'dir')
 await assert.rejects(ensureTools({root,names:['uv'],env:{PATH:''},platform:'win32',arch:'x64',run:fakeRun}),/符号链接/)
})
