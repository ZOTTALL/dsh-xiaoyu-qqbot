import fs from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {sha256} from '../lib/deploy-utils.mjs'
const root=fileURLToPath(new URL('..',import.meta.url)),pkg=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'))
export function renderInstaller(version,digest){
  if(!/^\d+\.\d+\.\d+$/.test(version)||!/^[a-f0-9]{64}$/.test(digest))throw new Error('安装脚本需要固定版本和 SHA256')
  const template=fs.readFileSync(path.join(root,'tools','install-template.ps1'),'utf8').replace(/^\uFEFF/,'')
  const script=template.replaceAll('@@VERSION@@',version).replaceAll('@@SHA256@@',digest)
  if(script.includes('@@'))throw new Error('安装脚本有未生成占位符')
  return '\uFEFF'+script
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const archive=path.resolve(process.argv[2]||'')
  if(!fs.existsSync(archive)||!archive.endsWith('.tgz'))throw new Error('传入已打包的 TGZ 绝对路径')
  const digest=await sha256(archive)
  fs.writeFileSync(path.join(root,'install.ps1'),renderInstaller(pkg.version,digest))
  console.log('INSTALLER_GENERATED=PASS;VERSION='+pkg.version+';SHA256='+digest)
}
