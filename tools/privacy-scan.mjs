import fs from 'node:fs'
import path from 'node:path'
import {execFileSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'
const root=path.resolve(process.argv[2]||fileURLToPath(new URL('..',import.meta.url)))
const forbidden=JSON.parse(process.env.QQBOT_PRIVACY_FORBIDDEN||'[]')
const candidates=execFileSync('git',['-C',root,'ls-files','--cached','--others','--exclude-standard','-z'],{encoding:'utf8'}).split('\0').filter(Boolean)
const findings=[]
for(const name of new Set(candidates)){
  const file=path.join(root,name);if(!fs.existsSync(file)||!fs.statSync(file).isFile())continue
  if(/(?:^|\/)(?:\.env(?:\..*)?|\.credentials[^/]*|node_modules|\.venv|workspace|memory-runtime)(?:\/|$)|\.(?:db|sqlite3?|wal|shm|pem|key|wav|mp3|pth|ckpt)$/i.test(name))findings.push({file:name,rule:'runtime-or-secret-file'})
  if(/\.(?:png|jpg|jpeg|gif|webp|ico|woff2?)$/i.test(name))continue
  const text=fs.readFileSync(file,'utf8')
  for(const value of forbidden)if(value&&text.toLowerCase().includes(String(value).toLowerCase()))findings.push({file:name,rule:'local-forbidden-marker'})
  if(/gh[pousr]_[A-Za-z0-9_]{30,}|github_pat_[A-Za-z0-9_]{40,}|sk-[A-Za-z0-9_-]{32,}|-----BEGIN (?:RSA |OPENSSH )?PRIVATE KEY-----/.test(text))findings.push({file:name,rule:'credential-pattern'})
}
console.log(JSON.stringify({result:findings.length?'PRIVACY=FAIL':'PRIVACY=PASS',files:new Set(candidates).size,findings},null,2))
if(findings.length)process.exitCode=1
