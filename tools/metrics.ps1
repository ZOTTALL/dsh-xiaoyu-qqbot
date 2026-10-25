# 巡检脚本：余额 / 今日花费 / 服务状态
# 用法: powershell -NoProfile -ExecutionPolicy Bypass -File metrics.ps1
# 配置来自 QQBOT_CONFIG 环境变量指向的 json（没设就用本插件目录下的 qqbot.config.json）。
$ErrorActionPreference = 'SilentlyContinue'
$out = @()

$cfgPath = $env:QQBOT_CONFIG
if (-not $cfgPath) { $cfgPath = Join-Path (Split-Path -Parent $PSScriptRoot) 'qqbot.config.json' }
$cfg = $null
if (Test-Path $cfgPath) { try { $cfg = Get-Content $cfgPath -Raw | ConvertFrom-Json } catch {} }
$ports = @{ napcatHttp = 3002; astrbotUi = 6185; astrbotWs = 6199; ingress = 3188 }
if ($cfg -and $cfg.ports) { foreach ($k in $ports.Keys) { if ($cfg.ports.$k) { $ports[$k] = $cfg.ports.$k } } }

# 1) DeepSeek API 余额
$credPath = "$env:USERPROFILE\.dsh\.credentials.yaml"
$cred = ''
if (Test-Path $credPath) { $cred = [System.IO.File]::ReadAllText($credPath) }
$key = ''
if ($cred -ne '') {
  $m = [regex]::Match($cred, 'DEEPSEEK_API_KEY:\s*([^\s,}]+)')
  if ($m.Success) { $key = $m.Groups[1].Value.Trim() }
}
if ($key -ne '') {
  try {
    $b = Invoke-RestMethod -Uri 'https://api.deepseek.com/user/balance' -Headers @{ Authorization = "Bearer $key" } -TimeoutSec 15
    $info = @($b.balance_infos)[0]
    $out += "BALANCE: $($info.total_balance) $($info.currency) available=$($b.is_available)"
  } catch { $out += "BALANCE: query_error ($($_.Exception.Message))" }
} else { $out += "BALANCE: no DEEPSEEK_API_KEY found" }

# 2) DSH 用量统计
$usagePath = "$env:USERPROFILE\.dsh\.dshw-usage.json"
if (Test-Path $usagePath) {
  try {
    $u = [System.IO.File]::ReadAllText($usagePath) | ConvertFrom-Json
    $today = (Get-Date).ToString('yyyy-MM-dd')
    $todayTokens = (@($u.events) | Where-Object { $_.day -eq $today } | Measure-Object -Property tokens -Sum).Sum
    $out += ("USAGE_TODAY: cost={0} CNY tokens={1} lastBalance={2}" -f $u.todayUsage, [long]$todayTokens, $u.lastBalance)
    $week = ($u.history.PSObject.Properties | Sort-Object Name | Select-Object -Last 7 | ForEach-Object { "$($_.Name)=$($_.Value)" }) -join ' '
    $out += "USAGE_WEEK: $week"
  } catch { $out += "USAGE: parse_error" }
} else { $out += "USAGE: no .dshw-usage.json" }

# 3) 服务状态
$ingress = $false
try { $h = Invoke-RestMethod -Uri "http://127.0.0.1:$($ports.ingress)/health" -TimeoutSec 5; $ingress = [bool]$h.ok } catch { $ingress = $false }
$astr = [bool](Get-NetTCPConnection -State Listen -LocalPort $ports.astrbotUi)
$napcat = ''
try { $li = Invoke-RestMethod -Uri "http://127.0.0.1:$($ports.napcatHttp)/get_login_info" -Method Post -Body '{}' -ContentType 'application/json' -TimeoutSec 6; $napcat = $li.data.user_id } catch { $napcat = '' }
$ws = @(Get-NetTCPConnection -State Established | Where-Object { $_.RemotePort -eq $ports.astrbotWs }).Count
$dsh = @(Get-Process | Where-Object { $_.ProcessName -like 'DeepSeek Harness*' }).Count
$out += "SERVICES: ingress=$ingress astrbot=$astr napcat=$napcat ws=$ws dshApp=$dsh"

$out -join "`n"
