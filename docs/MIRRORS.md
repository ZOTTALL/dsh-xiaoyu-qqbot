# 1.1.2 下载源、回退与覆盖范围

## 默认顺序

先校验本地缓存，再按下表顺序逐个尝试。文件下载的 HTTP / TLS 错误、超时、内容 SHA256 不符以及 Git 返回错误提交都会触发下一来源；所有来源失败才返回错误，保留已有文件与配置。固定版本缺货不会改下 latest，也不会关闭 TLS 或哈希校验。

| 本插件管理的资源 | 镜像 / 加速源顺序 | 最后回退 | 固定依据 |
|---|---|---|---|
| Git 2.56.0.4、uv 0.13.7（各 x64 / ARM64，共 4 个包） | 中科大 GitHub Release → gh-proxy | GitHub 官方 Release | `bootstrap-tools.manifest.json` SHA256 |
| Python 3.11.16 / 3.12.14（各 x64 / ARM64，共 4 个包） | 中科大 GitHub Release → gh-proxy | GitHub 官方 Release | `python-runtime.manifest.json` SHA256；uv 官方固定元数据 |
| NapCat v4.18.42 OneKey ZIP（1 个包） | gh-proxy | GitHub 官方 Release | `upstreams.json` SHA256 |
| AstrBot、AstrBot DSH 桥接、DSH ingress、GPT-SoVITS 源码（4 仓库） | GitClone → gh-proxy Git | GitHub 官方 Git | `upstreams.json` 完整 40 位提交；检出前后校验 |
| BGE 中文向量 / 重排模型（8 个文件） | HF-Mirror | Hugging Face 官方 | 原模型 manifest 的 revision / SHA256 |
| AstrBot、桥接、记忆 Python 依赖 | 清华 PyPI | PyPI 官方 | 同一 pyproject / requirements / 记忆版本锁 |
| ingress 本地插件包的 npm 依赖 | npmmirror | npm 官方 | DSH 宿主包管理器、上游 package 声明 |
| 本插件 1.1.2 TGZ（`install.ps1`） | gh-proxy | GitHub 官方 Release | 安装脚本内嵌相同 TGZ SHA256 |
| 本插件的 DSH 安装依赖（`install.ps1`） | npmmirror | npm 官方 | 同一个已校验本地 TGZ；不依赖 Git |

上表含 **17 个固定文件资源 + 4 个固定源码仓库**，另加本插件安装包。清单保留官方 URL 作为身份 / 哈希锚点，由 `lib/download-sources.mjs` 计算镜像候选，**清单中的官方 URL 并不代表先访问官方站**。中央策略在 `tools/download-sources.json`。不要直接编辑已发布的 node_modules 来持久配置；修改策略应在自己的源码副本中验证、重新打包。

中科大只镜像其目录列出的仓库，并可能只保留较新版本。其镜像缺货若重定向回 GitHub，本插件会先试剩余镜像，最后才请求官方站。HF-Mirror 若转回 huggingface.co 同理；镜像自己的 CDN 重定向允许且日志仅记录主机名。GitClone 缓存不一定含固定提交，fetch 失败 / 提交不符即尝试下一源。**国内可用加速源不等于所有服务器物理位置都在境内**，也不保证每个网络 / 时段均可用。

## 不修改全局配置、不转发账户凭据

- 源设置只传给当前下载 / 安装子进程，不执行全局 git config、不修改 npm / pip 系统配置、不修改系统 PATH。
- 公开 Git 拉取使用临时空全局配置，禁用系统 Git 配置、credential helper、askpass 和 extraHeader；全局 Git 的私有 URL 重写不带入镜像。仍保留用户网络代理变量。
- 公开依赖子进程剔除常见 TOKEN / API_KEY / SECRET / PASSWORD 等变量与私有索引覆盖。pip 使用空配置，uv 使用 `--no-config`；镜像 / 官方按**独立单源**重试，不加入 extra-index，避免无意混用同名包。
- 文件下载只发送公开 GET / Range 请求，不发送应用密钥。镜像只得到公开包路径及普通下载网络元数据。
- QQ / OneBot、语音服务、DSH ingress、模型 API、余额查询和聊天原文的请求地址**不会**改到这些镜像。

## Python 与依赖

uv 自动下载 Python 的隐式 GitHub 请求已改成显式下载：按固定版本从上述来源获得压缩包，SHA256 校验后生成本机 uv metadata，其 URL 仅指向该包的 `file:` 路径，再执行 uv 安装。安装位置 / 缓存均在部署根目录；不加全局 bin、不写 Python 注册表。3.11 用于记忆，3.12 用于 AstrBot，两者环境独立。uv 官方元数据固定在 0.13.7 对应文件，来源可见 manifest。

系统 uv >=0.13.7 才复用；旧版改用固定便携工具，不覆盖系统程序。手动显式传 `-Uv` / `--uv` 时也请使用 >=0.13.7。记忆依赖沿用版本锁；AstrBot / 上游桥接依赖遵循固定源码中的声明，**不声称所有传递依赖均已做哈希锁定**。

## 超时与故障定位

默认单镜像文件 / Git / Python 依赖尝试上限 10 分钟，官方上限 30 分钟；文件流连续 60 秒无数据、Git 连续 90 秒无输出也会结束当前来源。工具命令和本机解压另有较短上限。官方 / 镜像都失败时保留各源错误与暂存目录，网络恢复后重试。缓存只有哈希正确才复用，失败不覆盖已有目标。

在总览点 **“查看下载源 / 回退”** 可查看当前打包策略；部署日志显示“尝试”“切换下一来源”“校验通过”，不会以“下载完成”伪报账号 / 模型就绪。独立安装脚本每个 TGZ 来源上限 120 秒，错误哈希同样换源；桌面插件添加框只接受单条 URL，不会自动更换该 URL，需改填备用地址或使用脚本。

## 第三方独立安装器的边界

这里覆盖**插件及附带脚本主动发起的下载**。NapCatInstaller.exe 首次下载 QQ / 协议环境，AstrBot WebUI 内自行安装其他插件，GPT-SoVITS 上游另行运行的环境 / 权重安装脚本，及模型供应商服务请求，均由上游程序自己发起，不会被本插件偷偷代理或全局劫持。NapCat 和 GPT-SoVITS 仍有人工初始化 / 权重配置步骤；GPT-SoVITS 上游脚本如提供 HF-Mirror / ModelScope 选项可自行选用，不在此包里重复分发权重。

## 来源文档

- [中科大 GitHub Release 镜像说明](https://mirrors.ustc.edu.cn/help/github-release.html)
- [GitClone 官方服务](https://gitclone.com/) · [GH Proxy 官方服务](https://gh-proxy.com/)
- [HF-Mirror 官方说明](https://hf-mirror.com/)
- [清华 PyPI 使用说明](https://mirrors.tuna.tsinghua.edu.cn/help/pypi/)
- [npmmirror](https://npmmirror.com/)
- [uv 环境变量与本地 Python 元数据](https://docs.astral.sh/uv/reference/environment/)
