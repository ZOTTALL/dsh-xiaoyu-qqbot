param(
  [ValidatePattern('^[a-zA-Z0-9._-]+$')][string]$Profile='desktop',
  [string]$Dsh='',
  [string]$Destination='',
  [switch]$DownloadOnly
)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$OutputEncoding=[Console]::OutputEncoding
$env:PSModulePath=(Join-Path $PSHOME 'Modules')+';'+$env:PSModulePath
$Version='1.1.2'
$ExpectedSha='8a6c7c9182ea4189604ea4bd13ba81b6719d81018d4a937e24c924cc855a4a22'
if($ExpectedSha -notmatch '^[a-f0-9]{64}$'){throw '安装脚本未生成校验值，请使用发布页的 install.ps1。'}
if(!$Destination){$Destination=Join-Path $env:LOCALAPPDATA ('DSH-QQBOT\installer-cache\'+$Version)}
$Destination=[IO.Path]::GetFullPath($Destination)
New-Item -ItemType Directory -Path $Destination -Force | Out-Null
$Package=Join-Path $Destination ('dsh-xiaoyu-qqbot-'+$Version+'.tgz')
$Official='https://github.com/ZOTTALL/dsh-xiaoyu-qqbot/releases/download/v'+$Version+'/dsh-xiaoyu-qqbot-'+$Version+'.tgz'
$Sources=@(@{name='国内可用 GitHub 加速';url='https://gh-proxy.com/'+$Official},@{name='官方 GitHub';url=$Official})
$Valid=(Test-Path -LiteralPath $Package) -and ((Get-FileHash -LiteralPath $Package -Algorithm SHA256).Hash.ToLower() -eq $ExpectedSha)
if(!$Valid){
  foreach($Source in $Sources){
    $Part=$Package+'.'+[guid]::NewGuid().ToString('N')+'.part'
    try{
      Write-Output ('尝试'+$Source.name+'：'+$Source.url)
      Invoke-WebRequest -UseBasicParsing -Uri $Source.url -OutFile $Part -TimeoutSec 120
      if((Get-FileHash -LiteralPath $Part -Algorithm SHA256).Hash.ToLower() -ne $ExpectedSha){throw '安装包 SHA256 不匹配，切换下一来源。'}
      Move-Item -LiteralPath $Part -Destination $Package -Force
      $Valid=$true
      Write-Output ('下载完成并通过 SHA256：'+$Source.name)
      break
    }catch{Write-Output ('该来源未完成：'+$_.Exception.Message)}
    finally{if(Test-Path -LiteralPath $Part){Remove-Item -LiteralPath $Part -Force -ErrorAction SilentlyContinue}}
  }
}
if(!$Valid){throw '镜像与官方安装包均未通过校验，请稍后重试。'}
if($DownloadOnly){Write-Output ('DOWNLOAD_VERIFIED='+$Package);exit 0}
if(!$Dsh){
  $Command=Get-Command dsh -ErrorAction SilentlyContinue
  if($Command){$Dsh=$Command.Source}
  else{
    foreach($Candidate in @((Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd'),(Join-Path $env:ProgramFiles 'DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd'))){if(Test-Path -LiteralPath $Candidate){$Dsh=$Candidate;break}}
  }
}
if(!$Dsh -or !(Test-Path -LiteralPath $Dsh)){throw '安装包已校验；请用 -Dsh 指定 DSH 桌面端的 dsh.cmd 路径，再运行此脚本。'}
# Only preserve this selected profile's existing console configuration. Never upload it.
$HomeDir=$env:DSH_HOME
if(!$HomeDir){$HomeDir=Join-Path $env:USERPROFILE '.dsh'}
$Config=Join-Path $HomeDir ('profiles\'+$Profile+'\node_modules\dsh-xiaoyu-qqbot\qqbot.config.json')
$Backup=''
if(Test-Path -LiteralPath $Config){$Backup=Join-Path $Destination ('qqbot.config.before-'+(Get-Date -Format yyyyMMddHHmmssfff)+'.json');Copy-Item -LiteralPath $Config -Destination $Backup}
$Installed=$false
foreach($Registry in @('https://registry.npmmirror.com','https://registry.npmjs.org')){
  Write-Output ('安装到 DSH profile '+$Profile+'；包源：'+$Registry)
  & $Dsh plugin --profile $Profile add ('file:'+$Package.Replace('\','/')) --registry $Registry
  if($LASTEXITCODE -eq 0){$Installed=$true;break}
  Write-Output '该包源安装未完成，尝试下一来源。'
}
if($Backup -and !(Test-Path -LiteralPath $Config)){New-Item -ItemType Directory -Path (Split-Path $Config) -Force | Out-Null;Copy-Item -LiteralPath $Backup -Destination $Config}
if(!$Installed){throw 'DSH 安装未完成；已校验的包和配置备份保留在缓存目录。'}
Write-Output ('INSTALL=PASS;VERSION='+$Version+';PROFILE='+$Profile)
Write-Output '请按 DSH 提示重载 / 重启并刷新页面；保留安装缓存作为插件依赖来源。'
