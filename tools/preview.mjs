// 本地预览：用真实 core 数据 + 与宿主相同的路由，跑一个只读预览服务（仅用于验证 UI，不装进 DSH）。
// 用法：node tools/preview.mjs [port]
// 注意：无鉴权，仅限本机调试，别对公网暴露。
import http from 'node:http'
import { apply } from '../lib/index.js'

const port = Number(process.argv[2] || 8799)
const routes = []
apply({
  effect() {},
  on() { return () => {} },
  inject(_n, cb) { cb({ get() { return null }, webServer: { register(r) { routes.push(r); return () => {} }, tapIndex() { return () => {} } } }) },
})
http.createServer((req, res) => routes[0].handler(req, res)).listen(port, '127.0.0.1', () => {
  console.log(`preview on http://127.0.0.1:${port}/dsh-xiaoyu-qqbot/ui`)
})
