# 安全说明

控制台能启停进程、改人设文件、跑一键部署脚本（下载并执行第三方安装步骤），所以安全边界做得
比普通插件更严格。

## 网络面

- 所有路由只接受回环 Host（`127.0.0.1` / `localhost` / `::1`），不接受任何"受信任主机"扩展；
  这意味着**局域网里的其他设备访问不到这个面板**，只有本机浏览器能打开。
- `Sec-Fetch-Site: cross-site` 的请求一律拒绝；带 `Origin` 头时必须和 `Host` 同源。
- 宿主（DSH）的 `connection.requestRejection` 可用时会委托给它判断——浏览器没登录 DSH 会话时
  返回 401。
- 所有写操作（POST）必须带同源页面取到的 CSRF token（`GET /api/csrf`），不能从别的页面伪造请求。

## 文件面

- 人设/记忆编辑走白名单：只能改 `AGENTS.md`、`workspace/memory/*.md`、`voice.json`，其他路径
  一律拒绝，不接受路径穿越。
- 计划任务名、表情包 id 等入参都有正则校验，不做字符串拼接执行命令。
- 备份写入前会先复制一份到 `backups/`，误改能恢复。

## 一键部署的风险

一键部署会：

- 向 GitHub 发起 HTTPS 下载请求（NapCat 发行包、AstrBot/GPT-SoVITS 源码）；
- 在部署根目录下解压/clone/建虚拟环境/跑 `pip install`。

这些操作**只会落在你配置的部署根目录之下**，不会改动系统其他位置，也不会执行任何从网络内容
里解析出来的命令（只跑固定的 `git clone` / `pip install` / `Expand-Archive`）。但它仍然是在
执行第三方代码（AstrBot、GPT-SoVITS 的安装脚本和依赖），请在了解这些项目的前提下使用。

## 进程边界

启停操作只认部署根目录下的可执行文件路径（`Win32_Process.ExecutablePath like '<root>\*'`），
不会误杀你系统里其他正在运行的 QQ 或 Python 进程。

## 凭据

本插件不存储、不上传任何 API Key、密码或 token。QQ 号属于配置项（本地文件），不会随仓库提交；
表情包、记忆、人设文件默认也在 `.gitignore` 里排除。
