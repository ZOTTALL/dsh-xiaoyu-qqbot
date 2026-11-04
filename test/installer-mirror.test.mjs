import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import crypto from 'node:crypto'
import {renderInstaller} from '../tools/generate-installer.mjs'
import {streamCommand} from '../lib/deploy-utils.mjs'
const digest=bytes=>crypto.createHash('sha256').update(bytes).digest('hex')
test('installer: fixed digest is embedded in UTF-8 BOM script without generating package hash cycle',()=>{
 const s=renderInstaller('1.1.2',digest('fixture'));assert.ok(s.startsWith('\uFEFFparam'));assert.ok(s.includes(digest('fixture')));assert.ok(s.indexOf('https://gh-proxy.com/')<s.indexOf("@{name='官方 GitHub'"));assert.ok(!s.includes('@@'));const pkg=JSON.parse(fs.readFileSync(new URL('../package.json',import.meta.url)));assert.ok(!pkg.files.includes('install.ps1'))
})
test('installer: native PowerShell rejects corrupt mirror and verifies official fallback before install',async t=>{
 if(process.platform!=='win32')return
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'qqbot-install-test-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}))
 const requests=[],data=Buffer.from('verified package fixture'),server=http.createServer((req,res)=>{requests.push(req.url);res.end(req.url==='/mirror'?'corrupt mirror payload':data)})
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.closeAllConnections();server.close()})
 const base='http://127.0.0.1:'+server.address().port,src=path.join(root,'install.ps1'),dest=path.join(root,'cache')
 let script=renderInstaller('1.1.2',digest(data));script=script.replace(/^\$Sources=.*$/m,`$Sources=@(@{name='fixture mirror';url='${base}/mirror'},@{name='fixture official';url='${base}/official'})`);fs.writeFileSync(src,script)
 const ps=path.join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe'),r=await streamCommand(ps,['-NoProfile','-ExecutionPolicy','Bypass','-File',src,'-Destination',dest,'-DownloadOnly'])
 assert.equal(r.ok,true,r.tail);assert.match(r.tail,/SHA256/);assert.match(r.tail,/DOWNLOAD_VERIFIED=/);assert.deepEqual(requests,['/mirror','/official']);assert.deepEqual(fs.readFileSync(path.join(dest,'dsh-xiaoyu-qqbot-1.1.2.tgz')),data)
 // A second run verifies and uses the persistent cache instead of downloading again.
 const again=await streamCommand(ps,['-NoProfile','-ExecutionPolicy','Bypass','-File',src,'-Destination',dest,'-DownloadOnly']);assert.equal(again.ok,true,again.tail);assert.equal(requests.length,2)
})
