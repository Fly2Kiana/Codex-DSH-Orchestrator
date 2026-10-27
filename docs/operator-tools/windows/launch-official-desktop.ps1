# Operator-run only. Finish active work and quit both apps normally first.
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$NodePath,
    [Parameter(Mandatory = $true)][string]$DesktopExecutable,
    [Parameter(Mandatory = $true)][string]$CallerExecutable,
    [string]$BridgeRepository = (Join-Path $PSScriptRoot '..\..\..')
)

$ErrorActionPreference = 'Stop'
$handoff = Join-Path $BridgeRepository 'dist\authorized-caller.js'
$nativePipe = Join-Path $PSScriptRoot 'native-pipeline.cmd'
$safeStatus = Join-Path $PSScriptRoot 'safe-handoff-status.mjs'
foreach ($file in @($NodePath, $DesktopExecutable, $CallerExecutable, $handoff, $nativePipe, $safeStatus)) {
    if (-not [System.IO.Path]::IsPathRooted($file) -or -not (Test-Path -LiteralPath $file -PathType Leaf)) {
        throw 'Not started: check the selected executable and repository paths.'
    }
}
$callerName = [System.IO.Path]::GetFileNameWithoutExtension($CallerExecutable)
$runningApps = @(Get-Process -ErrorAction Stop | Where-Object {
    $_.ProcessName -in @($callerName, 'DeepSeek Harness')
})
if ($runningApps.Count -gt 0) {
    throw 'Not started: finish current work and quit Codex and official DeepSeek Harness, including tray instances.'
}
$launchFlags = @('ELECTRON_RUN_AS_NODE', 'ELECTRON_NO_ASAR', 'NODE_OPTIONS', 'NODE_PATH',
    'NODE_V8_COVERAGE', 'NODE_REDIRECT_WARNINGS', 'ELECTRON_ENABLE_LOGGING',
    'ELECTRON_LOG_FILE', 'ELECTRON_ENABLE_STACK_DUMPING')
if (@($launchFlags | Where-Object { [Environment]::GetEnvironmentVariable($_) }).Count -gt 0) {
    throw 'Not started: use a clean standalone PowerShell window outside Codex.'
}

# Pass only file paths through temporary process-local variables. Never put
# authorization in the batch file, arguments, output or persistent environment.
$pipePaths = @{
    CODEX_DSH_PIPE_NODE = (Resolve-Path -LiteralPath $NodePath).ProviderPath
    CODEX_DSH_PIPE_DESKTOP = (Resolve-Path -LiteralPath $DesktopExecutable).ProviderPath
    CODEX_DSH_PIPE_CALLER = (Resolve-Path -LiteralPath $CallerExecutable).ProviderPath
    CODEX_DSH_PIPE_HELPER = (Resolve-Path -LiteralPath $handoff).ProviderPath
}
$previousPaths = @{}
try {
    foreach ($name in $pipePaths.Keys) {
        $previousPaths[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
        [Environment]::SetEnvironmentVariable($name, $pipePaths[$name], 'Process')
    }
    Write-Output 'Starting official DSH and Codex. Keep this window open; do not press Ctrl+C.'
    # Invoke the batch directly. A PowerShell 5.1 native data pipeline can buffer
    # Desktop output until it exits, preventing the caller from ever opening.
    & $nativePipe
} finally {
    foreach ($name in $previousPaths.Keys) {
        [Environment]::SetEnvironmentVariable($name, $previousPaths[$name], 'Process')
    }
}
