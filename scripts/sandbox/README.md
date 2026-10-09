# Testing in a clean Windows (Windows Sandbox)

Each run starts a brand-new, empty Windows, installs ArcFlare the way a new
user would, and throws the whole machine away when you close the window.

One-time setup (admin PowerShell, then restart):

    Enable-WindowsOptionalFeature -Online -FeatureName Containers-DisposableClientVM -All

Run:

    powershell -ExecutionPolicy Bypass -File scripts\sandbox\start.ps1             # what users get today
    powershell -ExecutionPolicy Bypass -File scripts\sandbox\start.ps1 -Mode local # this repo, before release
    ...  -NoDesktop   skip the desktop installer
    ...  -Gpu         share the GPU with the sandbox

Results land in scripts/sandbox/results: a step-by-step log, a summary JSON
(which steps failed) and a screenshot of the desktop app running.
