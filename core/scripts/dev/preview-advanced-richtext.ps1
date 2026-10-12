param([int]$Port = 8796, [string]$ShortAnswerVersion = '1.3.0')
$ErrorActionPreference = 'Stop'
$coreRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$projectRoot = Split-Path -Parent $coreRoot
$previewRoot = Join-Path $projectRoot ('.temp/verification/advanced-richtext-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
$previewCore = Join-Path $previewRoot 'core'
New-Item -ItemType Directory -Path $previewCore | Out-Null
foreach ($folder in @('web','server','shared')) {
  Copy-Item -LiteralPath (Join-Path $coreRoot $folder) -Destination $previewCore -Recurse
}
New-Item -ItemType Directory -Path (Join-Path $previewRoot 'extensions'), (Join-Path $previewRoot 'question-banks') | Out-Null
$extensionPath = Join-Path $projectRoot "extensions/基础题型/short-answer-$ShortAnswerVersion"
if (-not (Test-Path -LiteralPath $extensionPath -PathType Container)) {
  $legacyFolder = if ($ShortAnswerVersion -eq '1.0.0') { 'short-answer' } else { "short-answer-$ShortAnswerVersion" }
  $extensionPath = Join-Path $coreRoot "test/fixtures/legacy-extensions/$legacyFolder"
}
Copy-Item -LiteralPath $extensionPath -Destination (Join-Path $previewRoot 'extensions') -Recurse
Copy-Item -LiteralPath (Join-Path $projectRoot 'extensions/基础题型/single-choice') -Destination (Join-Path $previewRoot 'extensions') -Recurse
Copy-Item -LiteralPath (Join-Path $projectRoot 'question-banks/java-foundations.json') -Destination (Join-Path $previewRoot 'question-banks')
$dependencyRoot = Join-Path $previewCore 'node_modules'
New-Item -ItemType Junction -Path $dependencyRoot -Target (Join-Path $coreRoot 'node_modules') | Out-Null
$demoRoot = Join-Path $previewRoot 'question-banks/advanced-richtext-demo'
New-Item -ItemType Directory -Path $demoRoot | Out-Null
$example = Get-Content -Raw -LiteralPath (Join-Path $extensionPath 'examples.json') | ConvertFrom-Json
$example.id = 'advanced-richtext-demo'
$example.title = '高级富文本演示'
$example | ConvertTo-Json -Depth 100 | Set-Content -Encoding utf8 -LiteralPath (Join-Path $demoRoot 'bank.json')
Copy-Item -LiteralPath (Join-Path $extensionPath 'assets') -Destination $demoRoot -Recurse
$nodePath = (Get-Command node).Source
$previewProcess = Start-Process -FilePath $nodePath -WindowStyle Hidden -PassThru -ArgumentList @(('"' + (Join-Path $coreRoot 'server/main.mjs') + '"'), '--root', ('"' + $previewRoot + '"'), '--host', '127.0.0.1', '--port', "$Port") -RedirectStandardOutput (Join-Path $previewRoot 'server.out.log') -RedirectStandardError (Join-Path $previewRoot 'server.err.log')
[pscustomobject]@{ Root=$previewRoot; Pid=$previewProcess.Id; Url="http://127.0.0.1:$Port/" } | ConvertTo-Json
