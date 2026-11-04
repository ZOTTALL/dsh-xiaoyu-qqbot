// CLI equivalent of the sidebar's Detect / Install Bridge action.
import {resolvePaths} from '../lib/config.mjs'
import {installBridge} from '../lib/bridge-install.mjs'
import path from 'node:path'
import fs from 'node:fs'
import {ensureTools} from '../lib/deploy-tools.mjs'
import {streamCommand} from '../lib/deploy-utils.mjs'
const p=resolvePaths()
if(!fs.existsSync(p.astrbotPy)||!fs.existsSync(path.join(p.astrbotDir,'main.py')))throw new Error('先部署 AstrBot 环境，再单独补装桥接')
const tools=await ensureTools({root:p.root,step:console.log})
const {uvPackages}=await import('../lib/uv-network.mjs')
const run=(file,args,options={})=>streamCommand(file==='git'?tools.tools.git:file,args,{...options,env:options.env||tools.env,step:console.log})
const installRequirements=file=>uvPackages(tools.tools.uv,['pip','install','--system-certs','--python',p.astrbotPy,'-r',file],{env:tools.env,step:console.log})
const result=await installBridge({root:p.root,pluginDir:path.dirname(p.astrbotPluginMain),python:p.astrbotPy,tmpDir:p.tmpDir,run,installRequirements,step:console.log})
console.log(JSON.stringify(result,null,2))
