# Starts a fresh Windows Sandbox and runs inside.ps1 in it.
#
#   powershell -ExecutionPolicy Bypass -File scripts\sandbox\start.ps1            # what users get today
#   powershell -ExecutionPolicy Bypass -File scripts\sandbox\start.ps1 -Mode local # this repo, unreleased
#
# Results (log, summary JSON, a screenshot of the app) land in
# scripts\sandbox\results on this machine. The sandbox is thrown away when its
# window closes, so every run starts from a clean Windows.
param(
  [ValidateSet("release", "local")] [string]$Mode = "release",
  [switch]$NoDesktop,
  [switch]$Gpu
)

$exe = "$env:windir\System32\WindowsSandbox.exe"
if (-not (Test-Path $exe)) {
  Write-Host "Windows Sandbox isn't turned on yet. In an ADMIN PowerShell, run:" -ForegroundColor Yellow
  Write-Host "  Enable-WindowsOptionalFeature -Online -FeatureName Containers-DisposableClientVM -All"
  Write-Host "then restart Windows, and run this script again."
  exit 1
}

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$repo = (Resolve-Path (Join-Path $here "..\..")).Path
$results = Join-Path $here "results"
New-Item -ItemType Directory -Force $results | Out-Null

$args_ = "-Mode $Mode" + $(if ($NoDesktop) { " -NoDesktop" } else { "" })
$wsb = @"
<Configuration>
  <vGPU>$(if ($Gpu) { "Enable" } else { "Disable" })</vGPU>
  <Networking>Enable</Networking>
  <MemoryInMB>8192</MemoryInMB>
  <MappedFolders>
    <MappedFolder><HostFolder>$here</HostFolder><SandboxFolder>C:\arcflare\scripts</SandboxFolder><ReadOnly>true</ReadOnly></MappedFolder>
    <MappedFolder><HostFolder>$repo</HostFolder><SandboxFolder>C:\arcflare\code</SandboxFolder><ReadOnly>true</ReadOnly></MappedFolder>
    <MappedFolder><HostFolder>$results</HostFolder><SandboxFolder>C:\arcflare\results</SandboxFolder><ReadOnly>false</ReadOnly></MappedFolder>
  </MappedFolders>
  <LogonCommand>
    <Command>powershell -ExecutionPolicy Bypass -NoExit -File C:\arcflare\scripts\inside.ps1 $args_</Command>
  </LogonCommand>
</Configuration>
"@
$file = Join-Path $env:TEMP "arcflare-test.wsb"
Set-Content -Path $file -Value $wsb -Encoding UTF8
Write-Host "Starting a clean Windows Sandbox ($Mode). Results will appear in:"
Write-Host "  $results"
Start-Process $exe -ArgumentList "`"$file`""
