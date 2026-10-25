# 每日巡检：把 metrics 结果整理一下，主动发到主人 QQ。
# 配置来自 QQBOT_CONFIG 环境变量指向的 json（没设就用本插件目录下的 qqbot.config.json）。
$ErrorActionPreference = 'SilentlyContinue'
$here = $PSScriptRoot
$cfgPath = $env:QQBOT_CONFIG
if (-not $cfgPath) { $cfgPath = Join-Path (Split-Path -Parent $here) 'qqbot.config.json' }
$cfg = $null
if (Test-Path $cfgPath) { try { $cfg = Get-Content $cfgPath -Raw | ConvertFrom-Json } catch {} }
$ownerQq = if ($cfg -and $cfg.ownerQq) { [int64]$cfg.ownerQq } else { 0 }
$napcatPort = if ($cfg -and $cfg.ports.napcatHttp) { $cfg.ports.napcatHttp } else { 3002 }
if (-not $ownerQq) { Write-Output 'no ownerQq configured; skip'; exit 0 }

$metrics = & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $here 'metrics.ps1')
if (-not $metrics) { $metrics = '（巡检脚本没有输出）' }
$now = Get-Date -Format 'MM-dd HH:mm'

$alarm = ''
$mb = [regex]::Match($metrics, 'BALANCE:\s*([0-9.]+)')
if ($mb.Success -and [double]$mb.Groups[1].Value -lt 3) { $alarm += "`n`n⚠️ 余额只剩 $($mb.Groups[1].Value) 了，记得充值。" }
if ($metrics -match 'ingress=False') { $alarm += "`n`n⚠️ DSH ingress 掉线了（桌面 App 开着吗？）" }
if ($metrics -match 'napcat=\s') { $alarm += "`n`n⚠️ NapCat 掉线了。" }
if ($metrics -match 'ws=0') { $alarm += "`n`n⚠️ NapCat 和 AstrBot 断开了。" }

$body = "📋 每日巡检（$now）`n`n$metrics$alarm"
$payload = @{ user_id = $ownerQq; message = $body } | ConvertTo-Json -Compress
$bytes = [System.Text.Encoding]::UTF8.GetBytes($payload)
try {
  $r = Invoke-RestMethod -Uri "http://127.0.0.1:$napcatPort/send_private_msg" -Method Post -Body $bytes -ContentType 'application/json; charset=utf-8' -TimeoutSec 15
  "sent: $($r | ConvertTo-Json -Compress)"
} catch { "send failed: $($_.Exception.Message)" }
