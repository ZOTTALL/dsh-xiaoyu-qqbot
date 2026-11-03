import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {installBridge,installTemplates,BRIDGE} from '../lib/bridge-install.mjs'
function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'qqbot-bridge-test-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return{root,pluginDir:path.join(root,'astrbot','data','plugins','astrbot_plugin_dsh'),tmpDir:path.join(root,'tmp')}}
test('bridge: pinned upstream clone publishes verified sources atomically',async t=>{
  const f=fixture(t),calls=[];let stage
  const run=async(file,args)=>{calls.push(args);if(args[0]==='init'){stage=args[1];fs.writeFileSync(path.join(stage,'main.py'),'# upstream fixture');fs.writeFileSync(path.join(stage,'metadata.yaml'),'name: bridge')};return{ok:true,stdout:args.includes('rev-parse')?BRIDGE.commit:'',stderr:''}}
  const result=await installBridge({...f,run});assert.equal(result.commit,BRIDGE.commit);assert.ok(fs.existsSync(path.join(f.pluginDir,'main.py')));assert.ok(calls.some(x=>x.includes(BRIDGE.commit)));assert.equal(result.needsReload,true)
})
test('bridge: existing installation and configuration never overwritten',async t=>{
  const f=fixture(t);fs.mkdirSync(f.pluginDir,{recursive:true});fs.writeFileSync(path.join(f.pluginDir,'main.py'),'USER_MODIFICATION');fs.writeFileSync(path.join(f.pluginDir,'config.json'),'USER_SETTINGS')
  const r=await installBridge({...f,run:()=>{throw new Error('must not network')}});assert.equal(r.skipped,true);assert.equal(fs.readFileSync(path.join(f.pluginDir,'main.py'),'utf8'),'USER_MODIFICATION');assert.equal(fs.readFileSync(path.join(f.pluginDir,'config.json'),'utf8'),'USER_SETTINGS')
})
test('bridge: failed checkout leaves no half-installed plugin and rejects outside paths',async t=>{
  const f=fixture(t);await assert.rejects(installBridge({...f,run:async()=>({ok:false,stderr:'fixture failure'})}),/失败/);assert.equal(fs.existsSync(f.pluginDir),false)
  await assert.rejects(installBridge({...f,pluginDir:path.join(f.root,'..','outside')}),/根目录/)
})
test('templates: initialize matching placeholders without overwriting existing persona',t=>{
  const{root}=fixture(t),workspace=path.join(root,'workspace');fs.mkdirSync(workspace);fs.writeFileSync(path.join(workspace,'AGENTS.md'),'USER_PERSONA')
  const r=installTemplates({workspace});assert.ok(r.created>10);assert.equal(r.preserved,1);assert.equal(fs.readFileSync(path.join(workspace,'AGENTS.md'),'utf8'),'USER_PERSONA');assert.ok(fs.existsSync(path.join(workspace,'memory','lore.md')))
})
