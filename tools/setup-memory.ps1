param(
  [string]$Root=(Join-Path $env:LOCALAPPDATA 'DSH-QQBOT'),
  [string]$Workspace='',
  [string]$Python='3.11',
  [string]$Uv='uv'
)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$OutputEncoding=[Console]::OutputEncoding
$env:PSModulePath=(Join-Path $PSHOME 'Modules')+';'+$env:PSModulePath
if(!$Workspace){$Workspace=Join-Path $Root 'workspace'}
if(!(Get-Command $Uv -ErrorAction SilentlyContinue)){throw '部署工具 uv 尚未就绪；请在控制台运行部署工具检查后重试。'}
$runtime=Join-Path $Root 'memory-runtime'
$envPython=Join-Path $runtime 'venv\Scripts\python.exe'
if(!(Test-Path -LiteralPath $envPython)){
  & $Uv venv --python $Python --managed-python (Join-Path $runtime 'venv')
  if($LASTEXITCODE){throw '创建独立 Python 3.11 环境失败'}
}
& $Uv pip sync --system-certs --python $envPython (Join-Path $PSScriptRoot 'memory-requirements.lock')
if($LASTEXITCODE){throw '安装固定版本依赖失败'}
$models=@(@{manifest='memory-model.manifest.json';folder='bge-small-zh-v1.5-int8'},@{manifest='memory-reranker.manifest.json';folder='bge-reranker-base-int8'})
foreach($spec in $models){
  $directory=Join-Path $runtime ('models\'+$spec.folder)
  New-Item -ItemType Directory -Path $directory -Force | Out-Null
  $manifest=Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot $spec.manifest) | ConvertFrom-Json
  foreach($file in $manifest.files){
    if($file.file -notmatch '^[A-Za-z0-9_.-]+$' -or $file.url -notlike 'https://huggingface.co/*'){throw '模型清单无效'}
    $target=Join-Path $directory $file.file
    if(!(Test-Path -LiteralPath $target) -or (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLower() -ne $file.sha256){
      Invoke-WebRequest -Uri $file.url -OutFile ($target+'.download')
      if((Get-FileHash -LiteralPath ($target+'.download') -Algorithm SHA256).Hash.ToLower() -ne $file.sha256){throw '模型 SHA256 校验失败'}
      Move-Item -LiteralPath ($target+'.download') -Destination $target -Force
    }
  }
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot $spec.manifest) -Destination (Join-Path $directory 'manifest.json') -Force
}
$cfg=Join-Path $Workspace 'data\memory-local.runtime.json'
New-Item -ItemType Directory -Path (Split-Path $cfg) -Force | Out-Null
if(Test-Path -LiteralPath $cfg){Copy-Item -LiteralPath $cfg -Destination ($cfg+'.before-setup-'+(Get-Date -Format yyyyMMddHHmmssfff))}
$data=@{python=$envPython;model=(Join-Path $runtime 'models\bge-small-zh-v1.5-int8');reranker=(Join-Path $runtime 'models\bge-reranker-base-int8');version=1}
[IO.File]::WriteAllText($cfg,($data | ConvertTo-Json),[Text.UTF8Encoding]::new($false))
Write-Output 'LOCAL_MEMORY_SETUP=PASS;PROVIDER=CPU;CLOUD=false'
