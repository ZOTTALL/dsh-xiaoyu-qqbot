// Actual plugin handler, loopback only. No bootstrap, service autostart, or writes in screenshot mode.
import http from 'node:http'
import {handle,closeLocalMemory} from '../lib/index.js'
const port=Number(process.argv[2]||8799)
const allowWrites=process.env.QQBOT_PREVIEW_WRITES==='1'
const server=http.createServer((req,res)=>{
  if(req.url==='/'){res.writeHead(200,{'content-type':'text/html; charset=utf-8'});res.end('<!doctype html><html lang="zh-CN"><title>QQ BOT 演示</title><a href="/dsh-xiaoyu-qqbot/ui">打开 QQ BOT 控制台</a><br><a href="/dsh-xiaoyu-qqbot/memory">打开记忆空间</a></html>');return}
  if(!allowWrites&&req.method!=='GET'){res.writeHead(405);res.end('read-only preview');return}
  handle(req,res,null)
})
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,async()=>{await closeLocalMemory();server.closeAllConnections();server.close(()=>process.exit(0))})
server.listen(port,'127.0.0.1',()=>console.log('QQBOT_PREVIEW=http://127.0.0.1:'+port+'/;READ_ONLY='+!allowWrites))
