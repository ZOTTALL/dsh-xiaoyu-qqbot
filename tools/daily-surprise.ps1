# 每日惊喜：让机器人人设写一条晚间消息，通过 NapCat 发到主人 QQ。
# 由计划任务（如 QQBot-Daily-Surprise）每天某个时间点调用。
$ErrorActionPreference = 'SilentlyContinue'
$here = $PSScriptRoot
$cfgPath = $env:QQBOT_CONFIG
if (-not $cfgPath) { $cfgPath = Join-Path (Split-Path -Parent $here) 'qqbot.config.json' }
$cfg = $null
if (Test-Path $cfgPath) { try { $cfg = Get-Content $cfgPath -Raw | ConvertFrom-Json } catch {} }
$ownerQq = if ($cfg -and $cfg.ownerQq) { [int64]$cfg.ownerQq } else { 0 }
$napcatPort = if ($cfg -and $cfg.ports.napcatHttp) { $cfg.ports.napcatHttp } else { 3002 }
if (-not $ownerQq) { Write-Output 'no ownerQq configured; skip'; exit 0 }

$logsDir = if ($cfg -and $cfg.paths.logsDir) { Join-Path $cfg.root $cfg.paths.logsDir } else { Join-Path (Split-Path -Parent $here) 'logs' }
New-Item -ItemType Directory -Force -Path $logsDir -ErrorAction SilentlyContinue | Out-Null
$log = Join-Path $logsDir 'daily-surprise.log'
function Log($m) { Add-Content -Path $log -Value ("[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m) -Encoding UTF8 }

$beaconPath = "$env:USERPROFILE\.dsh\astrbot-ingress.json"
$text = ''
if (Test-Path $beaconPath) {
  $beacon = Get-Content $beaconPath -Raw | ConvertFrom-Json
  $body = @{
    umo = 'task:daily-surprise'
    chatType = 'private'
    senderId = '0'
    text = '（定时任务）现在是晚上。请写一条给主人的消息：用你的人设口吻，一到三句短句；可以是关心、小心愿、或一句想说的话。只输出要发的内容，不要解释，不要前缀。'
    files = @()
    progress = @{ mode = 'minimal' }
  } | ConvertTo-Json -Depth 6
  try {
    $resp = Invoke-WebRequest -Uri 'http://127.0.0.1:3188/inbound' -Method Post -Headers @{ Authorization = "Bearer $($beacon.token)"; Accept = 'text/event-stream' } -Body ([System.Text.Encoding]::UTF8.GetBytes($body)) -ContentType 'application/json' -TimeoutSec 180 -UseBasicParsing
    $texts = @()
    foreach ($line in ($resp.Content -split "`n")) {
      $l = $line.Trim()
      if ($l.StartsWith('data:')) {
        $json = $l.Substring(5).Trim()
        try { $d = $json | ConvertFrom-Json; if ($d.text) { $texts += [string]$d.text } } catch {}
      }
    }
    $text = ($texts -join "`n").Trim()
    $text = $text -replace '——\s*本回合结束\s*$',''
    $text = $text.Trim()
  } catch {
    Log ("ingress error: " + $_.Exception.Message)
  }
}
if (-not $text) {
  $fallbacks = @(
    '今天也辛苦了，早点休息。',
    '明天也要好好吃饭。',
    '我今天很乖，晚安。'
  )
  $text = $fallbacks | Get-Random
  Log 'fallback used'
}
$payload = @{ user_id = $ownerQq; message = @(@{ type = 'text'; data = @{ text = $text } }) } | ConvertTo-Json -Depth 5
try {
  $r = Invoke-RestMethod -Uri "http://127.0.0.1:$napcatPort/send_private_msg" -Method Post -Body ([System.Text.Encoding]::UTF8.GetBytes($payload)) -ContentType 'application/json; charset=utf-8' -TimeoutSec 20
  Log ("sent: " + $text)
} catch {
  Log ("send error: " + $_.Exception.Message)
}
