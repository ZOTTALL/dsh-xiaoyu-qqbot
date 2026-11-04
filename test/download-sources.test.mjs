import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import {downloadSources,gitSources,downloadResource,publicDownloadEnv,publicGitEnv,fetchPinnedCommit,installBundleFromSources,pipPackages,sourcePolicy} from '../lib/download-sources.mjs'
import {uvPackages,ensurePython} from '../lib/uv-network.mjs'
import {setupMemory} from '../tools/setup-memory.mjs'
const hash=s=>crypto.createHash('sha256').update(s).digest('hex')
const commit='a'.repeat(40),other='b'.repeat(40)
function temp(t){const p=fs.mkdtempSync(path.join(os.tmpdir(),'qqbot-mirror-'));t.after(()=>fs.rmSync(p,{recursive:true,force:true}));return p}
const sources=[{name:'国内测试镜像',url:'https://mirror.example/file'},{name:'官方测试源',url:'https://official.example/file',official:true}]
test('sources: Git/uv/Python Release prefer university/proxy and keep official last',()=>{
 for(const repo of ['astral-sh/uv','git-for-windows/git','astral-sh/python-build-standalone']){const s=downloadSources('https://github.com/'+repo+'/releases/download/fixed/file.zip');assert.match(s[0].url,/^https:\/\/mirrors.ustc.edu.cn\//);assert.equal(s.at(-1).official,true);assert.ok(s.every(x=>x.url.includes('/fixed/file.zip')))}
})
test('sources: NapCat and installer releases prefer accelerator then official',()=>{
 for(const repo of ['NapNeko/NapCatQQ','ZOTTALL/dsh-xiaoyu-qqbot']){const s=downloadSources('https://github.com/'+repo+'/releases/download/v1/file.tgz');assert.match(s[0].url,/^https:\/\/gh-proxy.com\//);assert.equal(s.at(-1).official,true)}
})
test('sources: HF mirrors preserve exact revision/path, API/localhost endpoints never proxied',()=>{
 const u='https://huggingface.co/ORG/MODEL/resolve/'+commit+'/onnx/model.onnx';assert.equal(downloadSources(u)[0].url,u.replace('huggingface.co','hf-mirror.com'))
 for(const url of ['https://api.deepseek.com/user/balance','http://127.0.0.1:3002/get_login_info'])assert.deepEqual(downloadSources(url),[{name:'官方源',url:new URL(url).href,official:true}])
})
test('sources: public URLs reject embedded credentials, token queries and insecure remote HTTP',()=>{
 for(const u of ['https://user:password@example.test/file','https://example.test/file?token=secret','http://example.test/file'])assert.throws(()=>downloadSources(u))
})
test('sources: git alternatives preserve repository name and canonical URL',()=>{
 const r='https://github.com/CCYellowStar2/dsh-astrbot-ingress',s=gitSources(r);assert.match(s[0].url,/^https:\/\/gitclone.com\/github.com\//);assert.equal(s.at(-1).url,r);assert.ok(s.slice(0,-1).every(x=>x.url.endsWith('/CCYellowStar2/dsh-astrbot-ingress.git')))
})
test('mirror download: wrong SHA/HTML cannot publish; official fallback keeps same expected hash',async t=>{
 const root=temp(t),dest=path.join(root,'file'),good=Buffer.from('validated release');fs.writeFileSync(dest,'old')
 const calls=[],logs=[];await downloadResource('https://official.example/file',dest,hash(good),{sources,step:s=>logs.push(s),fetcher:async url=>{calls.push(url);return new Response(url.includes('mirror')?'<html>gateway</html>':good)}})
 assert.deepEqual(calls,sources.map(x=>x.url));assert.deepEqual(fs.readFileSync(dest),good);assert.ok(logs.some(x=>x.includes('SHA256')));assert.deepEqual(fs.readdirSync(root),['file'])
})
test('mirror download: timeout moves to official rather than bypassing integrity',async t=>{
 const calls=[],dest=path.join(temp(t),'file');await downloadResource('https://official.example/file',dest,hash('ok'),{sources,download:async(url,file,expected)=>{calls.push(url);assert.equal(expected,hash('ok'));if(url.includes('mirror'))throw new Error('ETIMEDOUT');fs.writeFileSync(file,'ok')}});assert.equal(calls.length,2)
})
test('mirror download: all-source failure preserves existing target and reports every source',async t=>{
 const dest=path.join(temp(t),'file');fs.writeFileSync(dest,'USER_FILE');await assert.rejects(downloadResource('https://official.example/file',dest,hash('expected'),{sources,download:async()=>{throw new Error('network fixture')}}),/国内测试镜像.*官方测试源/);assert.equal(fs.readFileSync(dest,'utf8'),'USER_FILE')
})
test('mirror download: valid local cache avoids every network source',async t=>{
 const dest=path.join(temp(t),'file');fs.writeFileSync(dest,'cache');await downloadResource('https://official.example/file',dest,hash('cache'),{download:()=>{throw new Error('unexpected network')}})
})
test('mirror download: redirects are observable without displaying signed query strings',async t=>{
 const logs=[];let calls=0;await downloadResource('https://official.example/file',path.join(temp(t),'file'),hash('ok'),{sources:[sources[0]],step:s=>logs.push(s),fetcher:async()=>++calls===1?new Response(null,{status:302,headers:{location:'https://cdn.example/file?signature=fixture'}}):new Response('ok')});assert.ok(logs.some(s=>s.includes('mirror.example → cdn.example')));assert.ok(logs.every(s=>!s.includes('signature=')))
})
test('mirror download: university cache miss tries remaining mirrors before official origin',async t=>{
 const seen=[],third={name:'第二镜像',url:'https://second.example/file'}
 await downloadResource('https://github.com/ORG/REPO/releases/download/v1/a.zip',path.join(temp(t),'a.zip'),hash('ok'),{sources:[sources[0],third,{name:'official',url:'https://github.com/ORG/REPO/releases/download/v1/a.zip',official:true}],fetcher:async u=>{seen.push(u);return u===sources[0].url?new Response(null,{status:302,headers:{location:'https://github.com/ORG/REPO/releases/download/v1/a.zip'}}):new Response('ok')}})
 assert.deepEqual(seen,[sources[0].url,third.url])
})
test('privacy: download child env drops credentials/index overrides but leaves parent unchanged',()=>{
 const input={PATH:'os',GITHUB_TOKEN:'fixture',OPENAI_API_KEY:'fixture',HF_TOKEN:'fixture',UV_INDEX_URL:'https://private.invalid',UV_INDEX_PRIVATE_PASSWORD:'fixture',PIP_INDEX_URL:'https://private.invalid',GIT_CONFIG_COUNT:'1',UV_CACHE_DIR:'cache'}
 const next=publicDownloadEnv(input);assert.equal(next.PATH,'os');assert.equal(next.UV_CACHE_DIR,'cache');assert.equal(next.GITHUB_TOKEN,undefined);assert.equal(next.OPENAI_API_KEY,undefined);assert.equal(next.UV_INDEX_URL,undefined);assert.equal(next.UV_INDEX_PRIVATE_PASSWORD,undefined);assert.equal(next.GIT_CONFIG_COUNT,undefined);assert.equal(input.GITHUB_TOKEN,'fixture')
})
test('privacy: public Git ignores user configs/extraHeaders/credential helpers without editing them',t=>{
 const root=temp(t),parent={GITHUB_TOKEN:'fixture',GIT_ASKPASS:'fixture'};const e=publicGitEnv(root,parent);assert.equal(e.GITHUB_TOKEN,undefined);assert.equal(e.GIT_ASKPASS,undefined);assert.equal(e.GIT_CONFIG_VALUE_0,'');assert.equal(e.GIT_CONFIG_VALUE_1,'');assert.equal(fs.readFileSync(e.GIT_CONFIG_GLOBAL,'utf8'),'');assert.equal(parent.GITHUB_TOKEN,'fixture')
})
test('Git fallback: wrong mirror FETCH_HEAD and failed accelerator never replace fixed commit',async t=>{
 let current='',successful=false;const seen=[]
 const run=async(file,args,opts)=>{assert.equal(opts.env.GITHUB_TOKEN,undefined);if(args.includes('set-url')){current=args.at(-1);return{ok:true}};if(args.includes('fetch')){seen.push(current);return{ok:!current.includes('second'),stderr:'fixture'}};return{ok:true,stdout:current.includes('first')?other:commit}}
 const ss=[{name:'first',url:'https://first.example/repo'},{name:'second',url:'https://second.example/repo'},{name:'official',url:'https://official.example/repo',official:true}]
 const result=await fetchPinnedCommit({stage:temp(t),repository:'https://github.com/ORG/REPO.git',commit,run,env:{GITHUB_TOKEN:'fixture'},sources:ss});assert.equal(result.official,true);assert.equal(seen.length,3);assert.equal(current,'https://github.com/ORG/REPO.git')
})
test('Git fallback: failed fetch cannot reuse stale FETCH_HEAD',async t=>{
 let reads=0;await assert.rejects(fetchPinnedCommit({stage:temp(t),repository:'https://github.com/ORG/REPO.git',commit,sources:[sources[0]],run:async(file,args)=>{if(args.includes('rev-parse')){reads++;return{ok:true,stdout:commit}}return{ok:!args.includes('fetch'),stderr:'fixture'}}}),/全部来源均失败/);assert.equal(reads,0)
})
test('uv PyPI: one default index per attempt, mirror failure/throw retries official without extra-index',async()=>{
 const attempts=[];await uvPackages('uv',['pip','sync','lock'],{env:{UV_INDEX_URL:'private',API_KEY:'fixture'},run:async(file,args,opts)=>{attempts.push(args);assert.equal(opts.env.API_KEY,undefined);assert.equal(opts.env.UV_INDEX_URL,undefined);if(attempts.length===1)throw new Error('mirror timeout');return{ok:true}}});assert.equal(attempts.length,2);assert.ok(attempts[0].includes(sourcePolicy.pypi[0].url));assert.ok(attempts[1].includes('https://pypi.org/simple'));assert.ok(attempts.every(x=>!x.some(y=>y.includes('extra-index'))))
})
test('pip bridge fallback: no inherited config, one index and same requirements on retry',async()=>{
 const calls=[];await pipPackages('python',['-m','pip','install','-r','requirements.txt'],{run:async(file,args,opts)=>{assert.ok(['NUL','/dev/null'].includes(opts.env.PIP_CONFIG_FILE));calls.push(args);return{ok:calls.length>1,stderr:'fixture'}}});assert.equal(calls.length,2);assert.ok(calls.every(a=>a.includes('--disable-pip-version-check')&&a.includes('requirements.txt')&&a.includes('--index-url')))
})
test('npm host install: npmmirror first, official fallback; existing bundle is not reinstalled',async()=>{
 const seen=[];await installBundleFromSources(async(spec,opts)=>{seen.push(opts.registry);return seen.length===1?{application:'failed',error:{code:'network'}}:{application:'restart-required'}},'file:C:/fixture.tgz');assert.deepEqual(seen,sourcePolicy.npm.map(x=>x.url));let count=0;await installBundleFromSources(async()=>{count++;return{application:'failed',error:{code:'already-installed'}}},'file:C:/fixture.tgz');assert.equal(count,1)
})
test('Python runtime: cached exact interpreter does not download',async t=>{
 const root=temp(t),exe=path.join(root,'python.exe');fs.writeFileSync(exe,'fixture');const r=await ensurePython({root,uv:'uv',version:'3.11',arch:'x64',run:async()=>({ok:true,stdout:exe}),download:()=>{throw new Error('unexpected network')}});assert.equal(r.version,'3.11.16');assert.equal(r.python,exe)
})
test('Python runtime: uncached archive uses pinned SHA, local uv metadata and no global registration',async t=>{
 const root=temp(t),exe=path.join(root,'python.exe');let found=0,downloaded=false
 const run=async(file,args,opts)=>{if(args.includes('find'))return ++found===1?{ok:false}:{ok:true,stdout:exe};assert.ok(args.includes('--no-bin')&&args.includes('--no-registry'));const data=JSON.parse(fs.readFileSync(opts.env.UV_PYTHON_DOWNLOADS_JSON_URL,'utf8'));assert.ok(Object.values(data).every(x=>x.url.startsWith('file:')&&/^[a-f0-9]{64}$/.test(x.sha256)));fs.writeFileSync(exe,'fixture');return{ok:true}}
 const r=await ensurePython({root,uv:'uv',version:'3.12',arch:'x64',run,download:async(url,dst,sha)=>{assert.match(url,/python-build-standalone/);assert.match(sha,/^[a-f0-9]{64}$/);fs.writeFileSync(dst,'fixture');downloaded=true}});assert.ok(downloaded);assert.equal(r.version,'3.12.14')
})
test('Python runtime: failed hash download never calls uv install or touches existing env',async t=>{
 let installs=0;await assert.rejects(ensurePython({root:temp(t),uv:'uv',version:'3.11',arch:'x64',run:async(f,a)=>{if(a.includes('install'))installs++;return{ok:false}},download:async()=>{throw new Error('SHA256 mismatch')}}),/SHA256/);assert.equal(installs,0)
})
test('memory setup: all eight fixed model files use common mirror helper and preserve old config on failure',async t=>{
 const root=temp(t),workspace=path.join(root,'workspace'),exe=path.join(root,'memory-runtime/venv/Scripts/python.exe');fs.mkdirSync(path.dirname(exe),{recursive:true});fs.writeFileSync(exe,'fixture');const cfg=path.join(workspace,'data/memory-local.runtime.json');fs.mkdirSync(path.dirname(cfg),{recursive:true});fs.writeFileSync(cfg,'USER_CONFIG');let count=0
 await assert.rejects(setupMemory({root,workspace,uv:'uv',step:()=>{},run:async()=>({ok:true}),download:async()=>{if(++count===3)throw new Error('mirror and official failed')}}),/mirror and official/);assert.equal(fs.readFileSync(cfg,'utf8'),'USER_CONFIG')
 const seen=[];await setupMemory({root,workspace,uv:'uv',step:()=>{},run:async()=>({ok:true}),download:async(url,file,sha)=>{assert.match(sha,/^[a-f0-9]{64}$/);seen.push(url);fs.writeFileSync(file,'fixture')}});assert.equal(seen.length,8);assert.ok(fs.readdirSync(path.dirname(cfg)).some(x=>x.includes('before-setup-')));assert.equal(JSON.parse(fs.readFileSync(cfg)).python,exe)
})
test('manifest audit: every managed download maps to mirror first and unchanged official last',()=>{
 const read=name=>JSON.parse(fs.readFileSync(new URL('../tools/'+name,import.meta.url),'utf8'))
 const tools=read('bootstrap-tools.manifest.json'),py=read('python-runtime.manifest.json'),up=read('upstreams.json'),resources=[up.napcat,...Object.values(tools).flatMap(t=>[t.x64,t.arm64]),...Object.values(py.metadata),...['memory-model.manifest.json','memory-reranker.manifest.json'].flatMap(f=>read(f).files)]
 for(const r of resources){const s=downloadSources(r.url);assert.ok(s.length>=2,r.url);assert.equal(s.at(-1).url,new URL(r.url).href);assert.match(r.sha256,/^[a-f0-9]{64}$/)}
 for(const key of ['astrbot','astrbotBridge','dshIngress','tts']){assert.ok(gitSources(up[key].repository).length>=2);assert.match(up[key].commit,/^[a-f0-9]{40}$/)}
})

test('bridge default command: sanitized child environment is actually forwarded',async()=>{
 const {runCommand}=await import('../lib/bridge-install.mjs');const r=await runCommand(process.execPath,['-e',"process.stdout.write(process.env.QQBOT_FIXTURE_ENV||'absent')"],{env:{...process.env,QQBOT_FIXTURE_ENV:'forwarded'}});assert.equal(r.ok,true);assert.equal(r.stdout.trim(),'forwarded')
})
