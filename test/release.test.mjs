import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
const root=fileURLToPath(new URL('..',import.meta.url)),read=name=>fs.readFileSync(path.join(root,name),'utf8')
test('release: minor version, real DSH engine range and desktop bundle are declared',()=>{
 const pkg=JSON.parse(read('package.json'));assert.match(pkg.version,/^1\.1\./);assert.equal(pkg.engines.dsh,'>=0.2.1-rc.2');assert.equal(pkg.dsh.platform,'win32');assert.ok(fs.existsSync(path.join(root,pkg.dsh.bundle.patch)));assert.equal(pkg.name,'dsh-xiaoyu-qqbot')
})
test('release: example configuration has no identities or automatic service startup',()=>{
 const c=JSON.parse(read('qqbot.config.example.json'));assert.equal(c.ownerQq,'');assert.equal(c.botQq,'');assert.ok(Object.values(c.autostart).every(x=>x===false));assert.equal(c.watchdog.enabled,false)
})
test('release: personality structure is placeholders and every expected memory type exists',()=>{
 const agents=read('persona-template/AGENTS.md');assert.ok(agents.includes('{{BOT_NAME}}'));assert.ok((agents.match(/^## /gm)||[]).length>=15)
 for(const name of ['facts.md','soul.md','user.md','lore.md','sticker-notes.md'])assert.ok(read('persona-template/memory/'+name).includes('{{'))
 assert.ok(fs.readdirSync(path.join(root,'persona-template/memory/stranger-chat')).length>=1)
})
test('release: bridge and ingress pinned to two distinct upstreams; no live submodule bundled',()=>{
 const locks=JSON.parse(read('tools/upstreams.json'));assert.match(locks.astrbotBridge.repository,/\/astrbot_plugin_dsh\.git$/);assert.match(locks.astrbotBridge.commit,/^[a-f0-9]{40}$/);assert.match(locks.dshIngress.spec,/\/dsh-astrbot-ingress#/);assert.equal(fs.existsSync(path.join(root,'astrbot-src')),false)
})

test('release: Chinese setup script has a UTF-8 BOM for Windows PowerShell 5.1',()=>{
 const bytes=fs.readFileSync(path.join(root,'tools/setup-memory.ps1'));assert.deepEqual([...bytes.subarray(0,3)],[239,187,191])
})
