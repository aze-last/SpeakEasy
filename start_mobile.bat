@echo off
setlocal EnableExtensions
cd /d "%~dp0"
for /f "usebackq delims=" %%I in (`powershell -NoProfile -Command "$raw = [string]::Join([Environment]::NewLine, (ipconfig)); $blocks = $raw -split '\r?\n\r?\n'; $selected = $null; foreach ($block in $blocks) { $ip = [regex]::Match($block, 'IPv4[^\r\n:]*:\s*([0-9\.]+)'); $gw = [regex]::Match($block, 'Default Gateway[^\r\n:]*:\s*([0-9\.]+)'); if ($ip.Success -and $gw.Success) { $candidate = $ip.Groups[1].Value; if ($candidate -notmatch '^(127|169\.254)\.') { $selected = $candidate; break } } }; if (-not $selected) { foreach ($block in $blocks) { $ip = [regex]::Match($block, 'IPv4[^\r\n:]*:\s*([0-9\.]+)'); if ($ip.Success) { $candidate = $ip.Groups[1].Value; if ($candidate -notmatch '^(127|169\.254)\.') { $selected = $candidate; break } } } }; if ($selected) { Write-Output $selected }"`) do set "LOCAL_IP=%%I"
if defined LOCAL_IP set "EXPO_PACKAGER_PROXY_URL=http://%LOCAL_IP%:8081"
if defined LOCAL_IP echo [INFO] Expo bundle URL forced to exp://%LOCAL_IP%:8081
call npx expo start --lan --clear
