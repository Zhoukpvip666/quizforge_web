param([string]$OutputPath = '', [switch]$SkipIcon)
$ErrorActionPreference = 'Stop'
$productRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))
if (-not $OutputPath) { $OutputPath = Join-Path $productRoot 'QuizForge.exe' }
$OutputPath = [IO.Path]::GetFullPath($OutputPath)
$compiler = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
if (-not (Test-Path -LiteralPath $compiler -PathType Leaf)) { throw '需要 Windows 的 .NET Framework C# 编译器。' }
$buildWork = Join-Path $productRoot '.temp/windows-launcher-build'
New-Item -ItemType Directory -Path $buildWork -Force | Out-Null
New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($OutputPath)) -Force | Out-Null
$arguments = @('/nologo', '/target:winexe', '/platform:x64', '/optimize+', '/utf8output', ('/out:' + $OutputPath),
  '/reference:System.Windows.Forms.dll', '/reference:System.Drawing.dll', '/reference:System.Core.dll', '/reference:System.Web.Extensions.dll')
if (-not $SkipIcon) {
  Add-Type -AssemblyName System.Drawing
  $sourceImage = [Drawing.Image]::FromFile((Join-Path $productRoot 'core/web/assets/quizforge-icon.png'))
  $bitmap = New-Object Drawing.Bitmap 256,256
  $graphics = [Drawing.Graphics]::FromImage($bitmap)
  $stream = New-Object IO.MemoryStream
  try {
    $graphics.DrawImage($sourceImage,0,0,256,256)
    $bitmap.Save($stream,[Drawing.Imaging.ImageFormat]::Png)
    $imageBytes = $stream.ToArray()
    $iconPath = Join-Path $buildWork 'quizforge.ico'
    $iconStream = [IO.File]::Create($iconPath)
    $writer = New-Object IO.BinaryWriter $iconStream
    try {
      $writer.Write([uint16]0); $writer.Write([uint16]1); $writer.Write([uint16]1)
      $writer.Write([byte]0); $writer.Write([byte]0); $writer.Write([byte]0); $writer.Write([byte]0)
      $writer.Write([uint16]1); $writer.Write([uint16]32); $writer.Write([uint32]$imageBytes.Length); $writer.Write([uint32]22)
      $writer.Write($imageBytes)
    } finally { $writer.Dispose(); $iconStream.Dispose() }
    $arguments += '/win32icon:' + $iconPath
  } finally { $stream.Dispose(); $graphics.Dispose(); $bitmap.Dispose(); $sourceImage.Dispose() }
}
$sources = Get-ChildItem -LiteralPath (Join-Path $productRoot 'core/desktop/windows') -Filter '*.cs' -File | Sort-Object Name | Select-Object -ExpandProperty FullName
& $compiler @arguments @sources
if ($LASTEXITCODE -ne 0) { throw 'QuizForge.exe 编译失败。' }
Write-Host "已生成：$OutputPath"
