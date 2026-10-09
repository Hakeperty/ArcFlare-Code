# Runs INSIDE Windows Sandbox: a brand-new Windows with nothing installed,
# exactly what a new user has. Installs ArcFlare the way a user would and logs
# every step to the results folder shared with the host.
#
#   -Mode release   install from arcflare.net (install.ps1) and the latest
#                   desktop release from GitHub: tests what users get today
#   -Mode local     install the CLI from the mapped repo (C:\arcflare\code):
#                   tests unreleased changes before they ship
param(
  [ValidateSet("release", "local")] [string]$Mode = "release",
  [switch]$NoDesktop
)

$ErrorActionPreference = "Continue"
$results = "C:\arcflare\results"
New-Item -ItemType Directory -Force $results | Out-Null
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$log = Join-Path $results "run-$stamp-$Mode.log"
$summary = [ordered]@{ mode = $Mode; started = (Get-Date).ToString("s"); steps = @() }

function Log($text) { $line = "[{0}] {1}" -f (Get-Date -Format "HH:mm:ss"), $text; Write-Host $line; Add-Content -Path $log -Value $line }

# One step: run it, capture output, record pass/fail and time.
function Step($name, [scriptblock]$body) {
  Log "=== $name"
  $t0 = Get-Date
  $ok = $true
  try {
    $out = & $body 2>&1 | Out-String
    if ($LASTEXITCODE -and $LASTEXITCODE -ne 0) { $ok = $false }
  } catch {
    $out = $_ | Out-String
    $ok = $false
  }
  Add-Content -Path $log -Value $out
  $secs = [math]::Round(((Get-Date) - $t0).TotalSeconds, 1)
  Log ("--- {0}: {1} ({2}s)" -f $name, $(if ($ok) { "ok" } else { "FAILED" }), $secs)
  $script:summary.steps += [ordered]@{ name = $name; ok = $ok; seconds = $secs }
  $global:LASTEXITCODE = 0
}

function Refresh-Path {
  $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User")
}

Log "ArcFlare sandbox test · mode $Mode · $([Environment]::OSVersion.VersionString)"

if ($Mode -eq "release") {
  # The real one-liner from the website, on a machine with no Node at all.
  Step "install.ps1 from arcflare.net" { Invoke-RestMethod https://arcflare.net/install.ps1 | Invoke-Expression }
  Refresh-Path
} else {
  # Unreleased code: a private Node, then the CLI from the mapped repo.
  Step "node (private copy)" {
    $index = Invoke-RestMethod https://nodejs.org/dist/index.json
    $lts = ($index | Where-Object { $_.lts } | Select-Object -First 1).version
    $zip = "$env:TEMP\node.zip"
    Invoke-WebRequest "https://nodejs.org/dist/$lts/node-$lts-win-x64.zip" -OutFile $zip
    Expand-Archive $zip -DestinationPath "$env:LOCALAPPDATA\node" -Force
    $script:nodeDir = (Get-ChildItem "$env:LOCALAPPDATA\node" -Directory | Select-Object -First 1).FullName
    $env:Path = "$script:nodeDir;$env:APPDATA\npm;$env:Path"
    node --version
  }
  Step "npm install -g (local repo)" {
    # Copy first: npm links a read-only mapped folder instead of installing it.
    Copy-Item C:\arcflare\code "$env:TEMP\arcflare-code" -Recurse -Force -Exclude node_modules, .git
    npm install -g "$env:TEMP\arcflare-code"
  }
}

Step "arcflare --version" { arcflare --version }
Step "arcflare doctor" { arcflare doctor }
Step "arcflare --help" { arcflare --help }
# Exists once the engine installer ships; harmless "unknown command" before.
Step "arcflare engine install" { arcflare engine install --yes }
Step "arcflare doctor (after engine)" { arcflare doctor }
Step "arcflare shop" { arcflare shop qwen3 }

if (-not $NoDesktop) {
  Step "desktop: download installer" {
    Invoke-WebRequest "https://github.com/Hakeperty/Arcflare-Desktop/releases/latest/download/ArcFlare-Setup-x64.exe" -OutFile "$env:TEMP\ArcFlare-Setup.exe"
    "{0:N1} MB" -f ((Get-Item "$env:TEMP\ArcFlare-Setup.exe").Length / 1MB)
  }
  Step "desktop: silent install" {
    $p = Start-Process "$env:TEMP\ArcFlare-Setup.exe" -ArgumentList "/S" -PassThru -Wait
    "installer exit code $($p.ExitCode)"
    if ($p.ExitCode -ne 0) { $global:LASTEXITCODE = $p.ExitCode }
  }
  Step "desktop: launch" {
    $exe = Get-ChildItem "$env:LOCALAPPDATA\Programs", "$env:ProgramFiles" -Recurse -Filter ArcFlare.exe -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $exe) { throw "ArcFlare.exe not found after install" }
    Start-Process $exe.FullName
    Start-Sleep 12
    $proc = Get-Process ArcFlare -ErrorAction SilentlyContinue
    if (-not $proc) { throw "the app exited within 12 s" }
    "running: $($exe.FullName) · $(@($proc).Count) process(es)"
    # A screenshot of the whole sandbox screen, for the host to look at.
    Add-Type -AssemblyName System.Windows.Forms, System.Drawing
    $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
    [System.Drawing.Graphics]::FromImage($bmp).CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
    $bmp.Save((Join-Path $results "desktop-$stamp.png"))
  }
}

$summary.finished = (Get-Date).ToString("s")
$summary.failed = @($summary.steps | Where-Object { -not $_.ok } | ForEach-Object { $_.name })
$summary | ConvertTo-Json -Depth 4 | Set-Content (Join-Path $results "summary-$stamp-$Mode.json")
Log ("DONE · {0} steps · {1} failed" -f $summary.steps.Count, $summary.failed.Count)
