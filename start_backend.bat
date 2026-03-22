@echo off
setlocal EnableExtensions
if not exist "%~dp0backend\venv\Scripts\python.exe" (
  echo [ERROR] Wala ang backend venv python.exe. Patakbuhin ulit ang setup.bat.
  exit /b 1
)
if not exist "%~dp0backend\venv\pyvenv.cfg" (
  echo [ERROR] Incomplete ang backend venv - missing pyvenv.cfg. Patakbuhin ulit ang setup.bat.
  exit /b 1
)
cd /d "%~dp0"
for /f "usebackq delims=" %%I in (`powershell -NoProfile -Command "$raw = [string]::Join([Environment]::NewLine, (ipconfig)); $blocks = $raw -split '\r?\n\r?\n'; $selected = $null; foreach ($block in $blocks) { $ip = [regex]::Match($block, 'IPv4[^\r\n:]*:\s*([0-9\.]+)'); $gw = [regex]::Match($block, 'Default Gateway[^\r\n:]*:\s*([0-9\.]+)'); if ($ip.Success -and $gw.Success) { $candidate = $ip.Groups[1].Value; if ($candidate -notmatch '^(127|169\.254)\.') { $selected = $candidate; break } } }; if (-not $selected) { foreach ($block in $blocks) { $ip = [regex]::Match($block, 'IPv4[^\r\n:]*:\s*([0-9\.]+)'); if ($ip.Success) { $candidate = $ip.Groups[1].Value; if ($candidate -notmatch '^(127|169\.254)\.') { $selected = $candidate; break } } } }; if ($selected) { Write-Output $selected }"`) do set "LOCAL_IP=%%I"
if defined LOCAL_IP echo [INFO] Backend API available at http://%LOCAL_IP%:8000
"%~dp0backend\venv\Scripts\python.exe" -m uvicorn server:app --host 0.0.0.0 --port 8000
