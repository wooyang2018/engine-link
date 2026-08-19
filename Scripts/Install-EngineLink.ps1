#Requires -Version 5.1
<#
.SYNOPSIS
  Build and install the EngineLink VSIX extension.

.DESCRIPTION
  Runs npm install (when needed), packages the extension with vsce, and installs
  the resulting .vsix into Cursor or VS Code.

.PARAMETER PackageOnly
  Only build the .vsix; do not install it.

.PARAMETER Editor
  Target editor CLI: Cursor, Code, or Both. Defaults to Cursor.

.PARAMETER SkipTest
  Skip `npm test` before packaging.

.PARAMETER Force
  Pass --force to the editor install command to replace an existing install.

.EXAMPLE
  .\Scripts\Install-EngineLink.ps1

.EXAMPLE
  .\Scripts\Install-EngineLink.ps1 -PackageOnly

.EXAMPLE
  .\Scripts\Install-EngineLink.ps1 -Editor Code -Force
#>
[CmdletBinding()]
param(
  [switch] $PackageOnly,
  [ValidateSet('Cursor', 'Code', 'Both')]
  [string] $Editor = 'Cursor',
  [switch] $SkipTest,
  [switch] $Force
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

function Write-Step {
  param([string] $Message)
  Write-Host ""
  Write-Host "==> $Message" -ForegroundColor Cyan
}

function Resolve-EditorCli {
  param([string] $Name)

  $command = Get-Command $Name.ToLowerInvariant() -ErrorAction SilentlyContinue
  if ($command) {
    return $command.Source
  }

  $candidates = switch ($Name) {
    'Cursor' {
      @(
        "$env:LOCALAPPDATA\Programs\cursor\resources\app\bin\cursor.cmd",
        "$env:LOCALAPPDATA\Programs\Cursor\resources\app\bin\cursor.cmd",
        'D:\Software\cursor\resources\app\bin\cursor.cmd'
      )
    }
    'Code' {
      @(
        "$env:LOCALAPPDATA\Programs\Microsoft VS Code\bin\code.cmd",
        "$env:ProgramFiles\Microsoft VS Code\bin\code.cmd",
        'D:\Software\Microsoft VS Code\bin\code.cmd'
      )
    }
    default { @() }
  }

  foreach ($candidate in $candidates) {
    if (Test-Path $candidate) {
      return (Resolve-Path $candidate).Path
    }
  }

  throw "Could not find the $Name CLI. Install $Name or add its bin directory to PATH."
}

function Get-LatestVsix {
  param([string] $Directory)

  $vsix = Get-ChildItem -Path $Directory -Filter '*.vsix' -File |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1

  if (-not $vsix) {
    throw "No .vsix file found in $Directory"
  }

  return $vsix.FullName
}

Write-Step "EngineLink extension install"
Write-Host "Repository: $repoRoot"

if (-not (Test-Path (Join-Path $repoRoot 'package.json'))) {
  throw "package.json not found. Run this script from the engine-link repository."
}

if (-not (Test-Path (Join-Path $repoRoot 'node_modules'))) {
  Write-Step "Installing npm dependencies"
  npm install
  if ($LASTEXITCODE -ne 0) { throw "npm install failed with exit code $LASTEXITCODE" }
}

if (-not $SkipTest) {
  Write-Step "Running tests"
  npm test
  if ($LASTEXITCODE -ne 0) { throw "npm test failed with exit code $LASTEXITCODE" }
}

Write-Step "Packaging VSIX"
npm run package
if ($LASTEXITCODE -ne 0) { throw "npm run package failed with exit code $LASTEXITCODE" }

$vsixPath = Get-LatestVsix -Directory $repoRoot
Write-Host "Packaged: $vsixPath" -ForegroundColor Green

if ($PackageOnly) {
  Write-Host ""
  Write-Host "PackageOnly set; skipping install." -ForegroundColor Yellow
  exit 0
}

$editors = switch ($Editor) {
  'Both' { @('Cursor', 'Code') }
  default { @($Editor) }
}

foreach ($editorName in $editors) {
  Write-Step "Installing into $editorName"
  $cli = Resolve-EditorCli -Name $editorName
  $installArgs = @('--install-extension', $vsixPath)
  if ($Force) {
    $installArgs += '--force'
  }

  Write-Host "$cli $($installArgs -join ' ')"
  & $cli @installArgs
  if ($LASTEXITCODE -ne 0) {
    throw "$editorName install failed with exit code $LASTEXITCODE"
  }
}

Write-Host ""
Write-Host "Done. Reload the editor window to activate the new extension." -ForegroundColor Green
Write-Host "Cursor: Developer: Reload Window" -ForegroundColor DarkGray
