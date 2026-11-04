param(
  [string]$Root=(Join-Path $env:LOCALAPPDATA 'DSH-QQBOT'),
  [string]$Workspace='',
  [string]$Python='3.11',
  [string]$Uv='',
  [string]$Node=''
)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$OutputEncoding=[Console]::OutputEncoding
$env:PSModulePath=(Join-Path $PSHOME 'Modules')+';'+$env:PSModulePath
if(!$Workspace){$Workspace=Join-Path $Root 'workspace'}
if(!$Node){
  $command=Get-Command node -ErrorAction SilentlyContinue
  if($command){$Node=$command.Source}
  else{$Node=Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\DeepSeek Harness.exe'}
}
if(!(Test-Path -LiteralPath $Node)){throw '请通过 QQ BOT 控制台部署，或使用 -Node 指定 Node / DSH 桌面运行时路径。'}
$argsList=@((Join-Path $PSScriptRoot 'setup-memory.mjs'),'--root',$Root,'--workspace',$Workspace,'--python',$Python)
if($Uv){$argsList+=@('--uv',$Uv)}
$old=$env:ELECTRON_RUN_AS_NODE
try{
  $env:ELECTRON_RUN_AS_NODE='1'
  & $Node @argsList
  $code=$LASTEXITCODE
}finally{$env:ELECTRON_RUN_AS_NODE=$old}
exit $code
