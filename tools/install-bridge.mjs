// CLI equivalent of the sidebar's Detect / Install Bridge action.
import {resolvePaths} from '../lib/config.mjs'
import {installBridge} from '../lib/bridge-install.mjs'
import path from 'node:path'
import fs from 'node:fs'
import {ensureTools} from '../lib/deploy-tools.mjs'
import {runCommand} from '../lib/deploy-utils.mjs'
const p=resolvePaths()
if(!fs.existsSync(p.astrbotPy)||!fs.existsSync(path.join(p.astrbotDir,'main.py')))throw new Error('先部署 AstrBot 环境，再单独补装桥接')
const tools=await ensureTools({root:p.root,step:console.log})
const run=(file,args,options={})=>file===p.astrbotPy&&args[0]==='-m'&&args[1]==='pip'
  ?runCommand(tools.tools.uv,['pip',...args.slice(2),'--python',p.astrbotPy],{...options,env:tools.env})
  :runCommand(file==='git'?tools.tools.git:file,args,{...options,env:tools.env})
const result=await installBridge({root:p.root,pluginDir:path.dirname(p.astrbotPluginMain),python:p.astrbotPy,tmpDir:p.tmpDir,run,step:console.log})
console.log(JSON.stringify(result,null,2))
