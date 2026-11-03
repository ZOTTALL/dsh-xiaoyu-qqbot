import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
async function fresh(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'qqbot-linkage-'));const cfg=path.join(root,'config.json');fs.writeFileSync(cfg,JSON.stringify({root,ports:{ingress:1}}));process.env.QQBOT_CONFIG=cfg;t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return{root,cfg,d:await import('../lib/deploy.mjs?'+Math.random())}}
async function wait(d,id){for(let n=0;n<200;n++){const j=d.getDeployJob(id);if(j.status!=='running')return j;await new Promise(r=>setTimeout(r,10))}throw new Error('fixture timeout')}
test('deploy: missing bridge prerequisite yields explicit error and no download',async t=>{const{d}=await fresh(t);const r=await d.deployBridge(),j=await wait(d,r.id);assert.equal(j.status,'error');assert.match(j.error,/AstrBot/)})
test('deploy: ingress installation receives fixed spec and reports restart rather than fake ready',async t=>{
  const{d}=await fresh(t);let spec;d.setIngressInstaller(async x=>{spec=x;return{application:'restart-required',enabled:true,packageResult:{exitCode:0}}})
  const j=await wait(d,(await d.deployIngress()).id);assert.equal(j.status,'partial');assert.equal(j.health.ok,false)
  // Callback itself takes no user-controlled URL; fixed source passed by the host binding.
  assert.equal(spec,undefined);assert.match(d.INGRESS_SPEC,/^github:CCYellowStar2\/dsh-astrbot-ingress#[a-f0-9]{40}$/)
})
test('deploy: already installed ingress is partial/preserved, failed install is error',async t=>{
  const{d}=await fresh(t);d.setIngressInstaller(async()=>({application:'failed',error:{code:'already-installed'}}));assert.equal((await wait(d,(await d.deployIngress()).id)).status,'partial')
  d.setIngressInstaller(async()=>({application:'failed',error:{code:'operation-error'}}));assert.equal((await wait(d,(await d.deployIngress()).id)).status,'error')
})
test('deploy: component selection validates before scheduling and keeps completed components',async t=>{
  const{d,root}=await fresh(t);await assert.rejects(d.deployAll(['user-supplied-command']),/无效/)
  fs.mkdirSync(path.join(root,'onekey','NapCat.Shell'),{recursive:true});fs.writeFileSync(path.join(root,'onekey','NapCat.Shell','NapCatWinBootMain.exe'),'fixture')
  const j=await wait(d,(await d.deployAll(['napcat'])).id);assert.equal(j.status,'done');assert.equal(j.components[0].status,'done')
})
