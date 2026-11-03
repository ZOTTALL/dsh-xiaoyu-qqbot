// CLI equivalent of the sidebar's Detect / Install Bridge action.
import {resolvePaths} from '../lib/config.mjs'
import {installBridge} from '../lib/bridge-install.mjs'
import path from 'node:path'
import fs from 'node:fs'
const p=resolvePaths()
if(!fs.existsSync(p.astrbotPy)||!fs.existsSync(path.join(p.astrbotDir,'main.py')))throw new Error('先部署 AstrBot 环境，再单独补装桥接')
const result=await installBridge({root:p.root,pluginDir:path.dirname(p.astrbotPluginMain),python:p.astrbotPy,tmpDir:p.tmpDir,step:console.log})
console.log(JSON.stringify(result,null,2))
