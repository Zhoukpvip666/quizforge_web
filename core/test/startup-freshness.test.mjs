import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const launcherPath = fileURLToPath(new URL('../../Start-QuizForge-Web.ps1', import.meta.url));
const quotePowerShell = value => `'${value.replaceAll("'", "''")}'`;

test('launcher checks running backend freshness before reusing its service', { skip: process.platform !== 'win32' }, () => {
  const temporary = fileURLToPath(new URL('../../.temp/node-migration/', import.meta.url));
  mkdirSync(temporary, { recursive: true });
  const fixtureRoot = mkdtempSync(path.join(temporary, 'quizforge-launcher-test-'));
  try {
    const core = path.join(fixtureRoot, 'core');
    for (const directory of ['server/host', 'node_modules', 'web']) mkdirSync(path.join(core, directory), { recursive: true });
    for (const file of ['package-lock.json', 'server/main.mjs', 'server/host/server.js', 'node_modules/.package-lock.json', 'web/app.js']) {
      writeFileSync(path.join(core, file), 'fixture');
    }
    const script = `
[string]$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
$tokens = $null
$parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile(${quotePowerShell(launcherPath)}, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count -gt 0) { throw 'Launcher has syntax errors' }
foreach ($name in @('Find-RunningQuizForge', 'Get-RunningQuizForgeRefreshReason')) {
  $definition = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }, $true)
  if (-not $definition) { throw "Missing launcher function: $name" }
  . ([ScriptBlock]::Create($definition.Extent.Text))
}
$projectRoot = ${quotePowerShell(fixtureRoot)}
$coreRoot = Join-Path $projectRoot 'core'
$Rebuild = $false
$SkipBuild = $false
$before = [DateTime]::Parse('2020-01-01T00:00:00Z').ToUniversalTime()
$started = [DateTime]::Parse('2021-01-01T00:00:00Z').ToUniversalTime()
$after = [DateTime]::Parse('2022-01-01T00:00:00Z').ToUniversalTime()
Get-ChildItem -LiteralPath $coreRoot -Recurse -File | ForEach-Object { $_.LastWriteTimeUtc = $before }
function Get-CimInstance {
  [pscustomobject]@{ Name = 'node.exe'; CommandLine = 'node "' + (Join-Path $coreRoot 'server/main.mjs') + '" --root "' + $projectRoot + '" --port 8787'; ProcessId = 123; CreationDate = $started }
}
$running = Find-RunningQuizForge
$cases = [ordered]@{ detectedPort = $running.Port; detectedPid = $running.Pid; detectedStart = $running.StartedAtUtc.ToString('o') }
$cases.fresh = Get-RunningQuizForgeRefreshReason $running
$source = Get-Item -LiteralPath (Join-Path $coreRoot 'server/host/server.js')
$source.LastWriteTimeUtc = $after
$cases.sourceUpdated = Get-RunningQuizForgeRefreshReason $running
$SkipBuild = $true
$cases.skipBuildSourceUpdated = Get-RunningQuizForgeRefreshReason $running
$source.LastWriteTimeUtc = $before
$lock = Get-Item -LiteralPath (Join-Path $coreRoot 'package-lock.json')
$lock.LastWriteTimeUtc = $after
$cases.lockUpdated = Get-RunningQuizForgeRefreshReason $running
$lock.LastWriteTimeUtc = $before
(Get-Item -LiteralPath (Join-Path $coreRoot 'web/app.js')).LastWriteTimeUtc = $after
$cases.frontendOnly = Get-RunningQuizForgeRefreshReason $running
$Rebuild = $true
$cases.rebuild = Get-RunningQuizForgeRefreshReason $running
$Rebuild = $false
$cases.unknownStart = Get-RunningQuizForgeRefreshReason ([pscustomobject]@{ Native = $true; StartedAtUtc = $null })
$cases.oldJava = Get-RunningQuizForgeRefreshReason ([pscustomobject]@{ Native = $false; StartedAtUtc = $started })
$cases | ConvertTo-Json -Compress
`;
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const result = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
      encoding: 'utf8', windowsHide: true, timeout: 15_000,
    }).trim());
    assert.equal(result.detectedPort, 8787);
    assert.equal(result.detectedPid, 123);
    assert.match(result.detectedStart, /^2021-01-01T00:00:00/);
    assert.equal(result.fresh, null);
    assert.match(result.sourceUpdated, /Node 后端或依赖已更新/);
    assert.equal(result.skipBuildSourceUpdated, result.sourceUpdated);
    assert.match(result.lockUpdated, /Node 后端或依赖已更新/);
    assert.equal(result.frontendOnly, null);
    assert.match(result.rebuild, /-Rebuild/);
    assert.match(result.unknownStart, /无法确认/);
    assert.match(result.oldJava, /旧 Java 后端/);

    const launcher = readFileSync(launcherPath, 'utf8');
    assert.match(launcher, /\$refreshReason = Get-RunningQuizForgeRefreshReason \$running\s+if \(\$refreshReason\) \{ throw[^\n]+\}\s+Open-ExistingQuizForge \$running/);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});
