# 隔离拉取 / 安装验收

不要为了测试而改现有桌面 profile。另开终端，仅在该进程中设置独立 DSH_HOME、QQBOT_CONFIG 和数据根目录；下面路径全是示例。

```powershell
$env:DSH_HOME='C:\QQBotTest\dsh-home'
$env:QQBOT_CONFIG='C:\QQBotTest\qqbot.config.json'
# 复制 qqbot.config.example.json 到该配置；修改 root 到 C:\QQBotTest\data。
# 所有组件端口改为未占用的测试端口；保持 autostart 和 watchdog 为 false。
dsh --profile qqbot-test --from-default-profile web --dump-config
dsh plugin --profile qqbot-test add https://github.com/ZOTTALL/dsh-xiaoyu-qqbot/releases/download/v1.1.1/dsh-xiaoyu-qqbot-1.1.1.tgz
dsh --profile qqbot-test --dump-config
dsh --profile qqbot-test --no-open --port 18990
```

使用的是**桌面版自带的 dsh 命令**，测试的是同一运行时的 bundle 解析、依赖获取、配置组合与服务启动。它不创建第二个桌面 Electron 窗口，也不把插件装入正式 desktop profile；桌面外壳的操作仍应在自己选择安装后验收。

独立 profile 的默认工作区为空，不复用任何现有账号、聊天或凭据。可先运行 `node tools/create-demo.mjs C:/QQBotTest/empty-demo` 建立虚构截图工作区，将输出的 demo.config.json 作为 QQBOT_CONFIG。

验收项目：包版本 1.1.1、bundle entry、路由 / 静态资源、注入脚本、主人 / 陌生人范围、向量回忆、安装任务状态、CSRF 拒绝、模板不覆盖、现有 private profile 文件 hash 未变化。测试环境不连接真实 QQ、不发消息、不启动当前机器已安装的机器人服务。

结束时关闭测试进程，退出该终端以丢弃环境变量。测试 profile / 数据独立保留供回退；不要递归删除未经确认的路径。
