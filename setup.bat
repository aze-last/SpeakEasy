@echo off
setlocal EnableExtensions EnableDelayedExpansion

cd /d "%~dp0"
set "REPO_ROOT=%CD%"
set "BACKEND_CANONICAL=%REPO_ROOT%\backend"
set "VENV_DIR=%BACKEND_CANONICAL%\venv"
set "VENV_PYTHON=%VENV_DIR%\Scripts\python.exe"
set "VENV_ACTIVATE=%VENV_DIR%\Scripts\activate.bat"
set "VENV_CFG=%VENV_DIR%\pyvenv.cfg"

call :step "Detecting project layout"
call :detect_paths
if errorlevel 1 exit /b 1

call :step "Checking Python 3.10+"
call :check_python
if errorlevel 1 exit /b 1

call :step "Checking Node.js and npm"
call :check_node
if errorlevel 1 exit /b 1

call :step "Checking Ollama"
call :check_ollama
if errorlevel 1 exit /b 1

call :step "Creating virtual environment"
call :create_venv
if errorlevel 1 exit /b 1

call :step "Installing backend dependencies"
call :install_backend_deps
if errorlevel 1 exit /b 1

call :step "Installing mobile dependencies"
call :install_mobile_deps
if errorlevel 1 exit /b 1

call :step "Checking Expo CLI and EAS CLI"
call :install_expo_cli
if errorlevel 1 exit /b 1

call :step "Detecting local IPv4 address"
call :detect_ip
if errorlevel 1 exit /b 1

call :step "Updating mobile/App.js server URL"
call :update_app_js
if errorlevel 1 exit /b 1

call :step "Creating launcher scripts"
call :write_start_backend
if errorlevel 1 exit /b 1
call :write_start_backend_dev
if errorlevel 1 exit /b 1
call :write_start_mobile
if errorlevel 1 exit /b 1
call :write_start_mobile_tunnel
if errorlevel 1 exit /b 1

call :step "Verifying backend responds on port 8000"
call :verify_backend
if errorlevel 1 exit /b 1

call :success_summary
exit /b 0

:detect_paths
if exist "%REPO_ROOT%\backend\server.py" (
  set "BACKEND_APP_DIR=%REPO_ROOT%\backend"
  set "BACKEND_MODE=nested"
) else if exist "%REPO_ROOT%\server.py" (
  set "BACKEND_APP_DIR=%REPO_ROOT%"
  set "BACKEND_MODE=flat"
) else (
  call :fail "Walang makita na server.py. Expected ko ito sa backend\server.py o sa repo root."
  exit /b 1
)

if exist "%REPO_ROOT%\mobile\package.json" (
  if exist "%REPO_ROOT%\mobile\App.js" (
    set "MOBILE_APP_DIR=%REPO_ROOT%\mobile"
    set "MOBILE_MODE=nested"
  )
)

if not defined MOBILE_APP_DIR (
  if exist "%REPO_ROOT%\package.json" (
    if exist "%REPO_ROOT%\App.js" (
      set "MOBILE_APP_DIR=%REPO_ROOT%"
      set "MOBILE_MODE=flat"
    )
  )
)

if not defined MOBILE_APP_DIR (
  call :fail "Walang makita na mobile app files. Expected ko ang package.json at App.js sa mobile\ o sa repo root."
  exit /b 1
)

if not exist "%BACKEND_CANONICAL%" (
  mkdir "%BACKEND_CANONICAL%" >nul 2>nul
  if errorlevel 1 (
    call :fail "Hindi ko magawa ang folder na backend\ para sa virtual environment."
    exit /b 1
  )
)

if /I "%BACKEND_MODE%"=="flat" (
  call :warn "backend\server.py not found. Gagamitin ko ang repo root server.py, pero ang venv ay ilalagay pa rin sa backend\venv."
)

if /I "%MOBILE_MODE%"=="flat" (
  call :warn "mobile\ folder not found. Gagamitin ko ang repo root App.js at package.json."
)

call :info "Backend app dir: %BACKEND_APP_DIR%"
call :info "Mobile app dir: %MOBILE_APP_DIR%"
exit /b 0

:check_python
set "PY_CMD="
set "PY_VERSION="

where py >nul 2>nul
if not errorlevel 1 (
  py -3.10 -c "import sys" >nul 2>nul
  if not errorlevel 1 set "PY_CMD=py -3.10"
)

if not defined PY_CMD (
  where python >nul 2>nul
  if not errorlevel 1 (
    for /f "usebackq delims=" %%I in (`python -c "import sys; print(f'{sys.version_info[0]}.{sys.version_info[1]}.{sys.version_info[2]}')" 2^>nul`) do set "PY_VERSION=%%I"
    if /I "%PY_VERSION:~0,4%"=="3.10" set "PY_CMD=python"
  )
)

if not defined PY_CMD (
  call :fail "Hindi ko makita ang Python 3.10. May nakita akong ibang Python versions, pero kailangan ng SpeakEasy ang 3.10 para sa PyTorch CUDA wheels. Paki-install o gamitin ang Python 3.10, then rerun setup.bat."
  exit /b 1
)

for /f "usebackq delims=" %%I in (`%PY_CMD% -c "import sys; print(f'{sys.version_info[0]}.{sys.version_info[1]}.{sys.version_info[2]}')" 2^>nul`) do set "PY_VERSION=%%I"
if not defined PY_VERSION (
  call :fail "Hindi ko mabasa ang Python version. Siguraduhing gumagana ang Python sa terminal."
  exit /b 1
)

set "PY_OK="
for /f "usebackq delims=" %%I in (`%PY_CMD% -c "import sys; print('YES' if sys.version_info[:2] == (3,10) else 'NO')" 2^>nul`) do set "PY_OK=%%I"
if /I not "%PY_OK%"=="YES" (
  call :fail "Python %PY_VERSION% ang nakita ko. Para stable ang torch/torchaudio CUDA install, Python 3.10 ang required ng setup na ito."
  exit /b 1
)

call :info "Python detected: %PY_VERSION%"
exit /b 0

:check_node
where node >nul 2>nul
if errorlevel 1 (
  call :fail "Walang Node.js sa system. Paki-install muna ang Node.js LTS at npm."
  exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
  call :fail "Walang npm sa system kahit may Node.js. Paki-reinstall ang Node.js LTS."
  exit /b 1
)

set "NODE_VERSION="
for /f "usebackq delims=" %%I in (`node -v 2^>nul`) do set "NODE_VERSION=%%I"
call :info "Node detected: %NODE_VERSION%"
exit /b 0

:check_ollama
where ollama >nul 2>nul
if errorlevel 1 (
  call :fail "Walang Ollama sa system. Paki-install muna ang Ollama bago ituloy ang setup."
  exit /b 1
)

set "OLLAMA_VERSION="
for /f "usebackq delims=" %%I in (`ollama --version 2^>nul`) do set "OLLAMA_VERSION=%%I"

powershell -NoProfile -Command "$ProgressPreference='SilentlyContinue'; try { $response = Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:11434/api/tags' -TimeoutSec 5; if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 300) { exit 0 } else { exit 1 } } catch { exit 1 }"
if errorlevel 1 (
  call :fail "Nakainstall ang Ollama pero hindi ito reachable sa http://127.0.0.1:11434. Paki-run muna ang: ollama serve"
  exit /b 1
)

ollama list | findstr /I "qwen2.5" >nul 2>nul
if errorlevel 1 (
  call :warn "Hindi ko nakita ang qwen2.5 sa ollama list. Kung kailangan, i-run ito mamaya: ollama pull qwen2.5"
)

call :info "Ollama detected: %OLLAMA_VERSION%"
exit /b 0

:create_venv
if exist "%VENV_PYTHON%" (
  set "VENV_PY_VERSION="
  for /f "usebackq delims=" %%I in (`"%VENV_PYTHON%" -c "import sys; print(f'{sys.version_info[0]}.{sys.version_info[1]}.{sys.version_info[2]}')" 2^>nul`) do set "VENV_PY_VERSION=%%I"

  if not exist "%VENV_CFG%" (
    call :warn "Existing venv is missing pyvenv.cfg. Recreating backend\venv with Python 3.10."
    rmdir /s /q "%VENV_DIR%"
    if errorlevel 1 (
      call :fail "Hindi ko matanggal ang lumang backend\venv. Isara muna ang terminals na gumagamit nito, then rerun setup.bat."
      exit /b 1
    )
  ) else if not exist "%VENV_ACTIVATE%" (
    call :warn "Existing venv is missing activate.bat. Recreating backend\venv with Python 3.10."
    rmdir /s /q "%VENV_DIR%"
    if errorlevel 1 (
      call :fail "Hindi ko matanggal ang lumang backend\venv. Isara muna ang terminals na gumagamit nito, then rerun setup.bat."
      exit /b 1
    )
  ) else if not defined VENV_PY_VERSION (
    call :warn "Existing venv looks broken or unreadable. Recreating backend\venv with Python 3.10."
    rmdir /s /q "%VENV_DIR%"
    if errorlevel 1 (
      call :fail "Hindi ko matanggal ang lumang backend\venv. Isara muna ang terminals na gumagamit nito, then rerun setup.bat."
      exit /b 1
    )
  ) else if /I not "%VENV_PY_VERSION:~0,4%"=="3.10" (
    call :warn "Existing venv uses Python %VENV_PY_VERSION%. Recreating backend\venv with Python 3.10."
    rmdir /s /q "%VENV_DIR%"
    if errorlevel 1 (
      call :fail "Hindi ko matanggal ang lumang backend\venv. Isara muna ang terminals na gumagamit nito, then rerun setup.bat."
      exit /b 1
    )
  ) else (
    call :info "Existing venv found at %VENV_DIR%"
  )
)

if not exist "%VENV_PYTHON%" (
  %PY_CMD% -m venv "%VENV_DIR%"
  if errorlevel 1 (
    call :fail "Hindi nagawa ang virtual environment sa backend\venv."
    exit /b 1
  )
) else (
  rem existing Python 3.10 venv is fine
)

if not exist "%VENV_CFG%" (
  call :fail "Nagawa ang backend\venv pero walang pyvenv.cfg. Mukhang incomplete ang venv creation."
  exit /b 1
)

if not exist "%VENV_ACTIVATE%" (
  call :fail "Nagawa ang backend\venv pero walang Scripts\activate.bat. Mukhang incomplete ang venv creation."
  exit /b 1
)

call :info "Backend virtual environment is ready."
exit /b 0

:install_backend_deps
"%VENV_PYTHON%" -m pip install --upgrade pip setuptools wheel
if errorlevel 1 (
  call :fail "Nag-fail ang pip upgrade sa backend venv."
  exit /b 1
)

"%VENV_PYTHON%" -m pip install fastapi uvicorn python-multipart openai-whisper httpx
if errorlevel 1 (
  call :fail "Nag-fail ang pag-install ng FastAPI/Whisper/httpx packages."
  exit /b 1
)

"%VENV_PYTHON%" -m pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu121
if errorlevel 1 (
  call :fail "Nag-fail ang CUDA 12.1 PyTorch install. Check internet connection at CUDA wheel availability."
  exit /b 1
)

call :info "Backend dependencies installed in %VENV_DIR%"
exit /b 0

:install_mobile_deps
pushd "%MOBILE_APP_DIR%" >nul
if errorlevel 1 (
  call :fail "Hindi ko ma-open ang mobile app folder para mag-npm install."
  exit /b 1
)

call npm install
set "NPM_RESULT=%ERRORLEVEL%"
popd >nul

if not "%NPM_RESULT%"=="0" (
  call :fail "Nag-fail ang npm install sa mobile app."
  exit /b 1
)

call :info "Mobile dependencies installed."
exit /b 0

:install_expo_cli
set "NEED_EXPO_INSTALL=0"

where expo >nul 2>nul
if errorlevel 1 set "NEED_EXPO_INSTALL=1"

where eas >nul 2>nul
if errorlevel 1 set "NEED_EXPO_INSTALL=1"

if "%NEED_EXPO_INSTALL%"=="1" (
  call :info "Installing expo-cli and eas-cli globally..."
  call npm install -g expo-cli eas-cli
  if errorlevel 1 (
    call :fail "Nag-fail ang global install ng expo-cli/eas-cli. Baka kailangan ng bagong terminal o admin permissions."
    exit /b 1
  )
) else (
  call :info "Expo CLI and EAS CLI already available."
)

exit /b 0

:detect_ip
set "LOCAL_IP="
for /f "usebackq delims=" %%I in (`powershell -NoProfile -Command "$raw = [string]::Join([Environment]::NewLine, (ipconfig)); $blocks = $raw -split '\r?\n\r?\n'; $selected = $null; foreach ($block in $blocks) { $ip = [regex]::Match($block, 'IPv4[^\r\n:]*:\s*([0-9\.]+)'); $gw = [regex]::Match($block, 'Default Gateway[^\r\n:]*:\s*([0-9\.]+)'); if ($ip.Success -and $gw.Success) { $candidate = $ip.Groups[1].Value; if ($candidate -notmatch '^(127|169\.254)\.') { $selected = $candidate; break } } }; if (-not $selected) { foreach ($block in $blocks) { $ip = [regex]::Match($block, 'IPv4[^\r\n:]*:\s*([0-9\.]+)'); if ($ip.Success) { $candidate = $ip.Groups[1].Value; if ($candidate -notmatch '^(127|169\.254)\.') { $selected = $candidate; break } } } }; if ($selected) { Write-Output $selected }"`) do set "LOCAL_IP=%%I"

if not defined LOCAL_IP (
  call :fail "Hindi ko ma-detect ang local IPv4 via ipconfig. Siguraduhing connected ka sa WiFi o LAN."
  exit /b 1
)

call :info "Detected local IPv4: %LOCAL_IP%"
exit /b 0

:update_app_js
set "APP_JS_PATH=%MOBILE_APP_DIR%\App.js"
if not exist "%APP_JS_PATH%" (
  call :fail "Hindi ko makita ang App.js para ma-update ang SERVER_URL."
  exit /b 1
)

powershell -NoProfile -Command "$ip = '%LOCAL_IP%'; $parsed = $null; if ([System.Net.IPAddress]::TryParse($ip, [ref]$parsed) -and $parsed.AddressFamily -eq [System.Net.Sockets.AddressFamily]::InterNetwork) { exit 0 } else { exit 1 }"
if errorlevel 1 (
  call :fail "Invalid o blank ang detected LOCAL_IP value: %LOCAL_IP%"
  exit /b 1
)

powershell -NoProfile -Command "$path = '%APP_JS_PATH%'; $q = [char]34; $content = Get-Content -Path $path -Raw; $pattern = 'const SERVER_URL = ' + $q + 'http://[^' + $q + ']*:8000' + $q; if (-not [regex]::IsMatch($content, $pattern)) { throw 'SERVER_URL placeholder not found.' }; $replacement = 'const SERVER_URL = ' + $q + 'http://%LOCAL_IP%:8000' + $q; $updated = [regex]::Replace($content, $pattern, $replacement, 1); $encoding = [System.Text.UTF8Encoding]::new($false); [System.IO.File]::WriteAllText($path, $updated, $encoding)"
if errorlevel 1 (
  call :fail "Hindi ko ma-update ang SERVER_URL sa App.js. Check kung nandiyan pa ang const SERVER_URL line."
  exit /b 1
)

call :info "App.js updated with http://%LOCAL_IP%:8000"
exit /b 0

:write_start_backend
if /I "%BACKEND_MODE%"=="nested" (
  (
    echo @echo off
    echo setlocal EnableExtensions
    echo if not exist "%%~dp0backend\venv\Scripts\python.exe" ^(
    echo   echo [ERROR] Wala ang backend venv python.exe. Patakbuhin ulit ang setup.bat.
    echo   exit /b 1
    echo ^)
    echo if not exist "%%~dp0backend\venv\pyvenv.cfg" ^(
    echo   echo [ERROR] Incomplete ang backend venv - missing pyvenv.cfg. Patakbuhin ulit ang setup.bat.
    echo   exit /b 1
    echo ^)
    echo cd /d "%%~dp0backend"
    echo for /f "usebackq delims=" %%%%I in ^(`powershell -NoProfile -Command "$raw = [string]::Join([Environment]::NewLine, (ipconfig^)^); $blocks = $raw -split '\r?\n\r?\n'; $selected = $null; foreach ^($block in $blocks^) { $ip = [regex]::Match^($block, 'IPv4[^\r\n:]*:\s*([0-9\.]+)'^); $gw = [regex]::Match^($block, 'Default Gateway[^\r\n:]*:\s*([0-9\.]+)'^); if ^($ip.Success -and $gw.Success^) { $candidate = $ip.Groups[1].Value; if ^($candidate -notmatch '^(127|169\.254)\.'^) { $selected = $candidate; break } } }; if ^(-not $selected^) { foreach ^($block in $blocks^) { $ip = [regex]::Match^($block, 'IPv4[^\r\n:]*:\s*([0-9\.]+)'^); if ^($ip.Success^) { $candidate = $ip.Groups[1].Value; if ^($candidate -notmatch '^(127|169\.254)\.'^) { $selected = $candidate; break } } } }; if ^($selected^) { Write-Output $selected }"`^) do set "LOCAL_IP=%%%%I"
    echo if defined LOCAL_IP echo [INFO] Backend API available at http://%%LOCAL_IP%%:8000
    echo "%%~dp0backend\venv\Scripts\python.exe" -m uvicorn server:app --host 0.0.0.0 --port 8000
  ) > "%REPO_ROOT%\start_backend.bat"
) else (
  (
    echo @echo off
    echo setlocal EnableExtensions
    echo if not exist "%%~dp0backend\venv\Scripts\python.exe" ^(
    echo   echo [ERROR] Wala ang backend venv python.exe. Patakbuhin ulit ang setup.bat.
    echo   exit /b 1
    echo ^)
    echo if not exist "%%~dp0backend\venv\pyvenv.cfg" ^(
    echo   echo [ERROR] Incomplete ang backend venv - missing pyvenv.cfg. Patakbuhin ulit ang setup.bat.
    echo   exit /b 1
    echo ^)
    echo cd /d "%%~dp0"
    echo for /f "usebackq delims=" %%%%I in ^(`powershell -NoProfile -Command "$raw = [string]::Join([Environment]::NewLine, (ipconfig^)^); $blocks = $raw -split '\r?\n\r?\n'; $selected = $null; foreach ^($block in $blocks^) { $ip = [regex]::Match^($block, 'IPv4[^\r\n:]*:\s*([0-9\.]+)'^); $gw = [regex]::Match^($block, 'Default Gateway[^\r\n:]*:\s*([0-9\.]+)'^); if ^($ip.Success -and $gw.Success^) { $candidate = $ip.Groups[1].Value; if ^($candidate -notmatch '^(127|169\.254)\.'^) { $selected = $candidate; break } } }; if ^(-not $selected^) { foreach ^($block in $blocks^) { $ip = [regex]::Match^($block, 'IPv4[^\r\n:]*:\s*([0-9\.]+)'^); if ^($ip.Success^) { $candidate = $ip.Groups[1].Value; if ^($candidate -notmatch '^(127|169\.254)\.'^) { $selected = $candidate; break } } } }; if ^($selected^) { Write-Output $selected }"`^) do set "LOCAL_IP=%%%%I"
    echo if defined LOCAL_IP echo [INFO] Backend API available at http://%%LOCAL_IP%%:8000
    echo "%%~dp0backend\venv\Scripts\python.exe" -m uvicorn server:app --host 0.0.0.0 --port 8000
  ) > "%REPO_ROOT%\start_backend.bat"
)

if errorlevel 1 (
  call :fail "Hindi ko magawa ang start_backend.bat."
  exit /b 1
)

exit /b 0

:write_start_backend_dev
if /I "%BACKEND_MODE%"=="nested" (
  (
    echo @echo off
    echo setlocal EnableExtensions
    echo if not exist "%%~dp0backend\venv\Scripts\python.exe" ^(
    echo   echo [ERROR] Wala ang backend venv python.exe. Patakbuhin ulit ang setup.bat.
    echo   exit /b 1
    echo ^)
    echo if not exist "%%~dp0backend\venv\pyvenv.cfg" ^(
    echo   echo [ERROR] Incomplete ang backend venv - missing pyvenv.cfg. Patakbuhin ulit ang setup.bat.
    echo   exit /b 1
    echo ^)
    echo echo [WARN] Experimental ito sa Windows kapag Torch/Whisper/CUDA ang gamit. Kapag nag-crash, gamitin ang start_backend.bat.
    echo cd /d "%%~dp0backend"
    echo "%%~dp0backend\venv\Scripts\python.exe" -m uvicorn server:app --host 0.0.0.0 --port 8000 --reload
  ) > "%REPO_ROOT%\start_backend_dev.bat"
) else (
  (
    echo @echo off
    echo setlocal EnableExtensions
    echo if not exist "%%~dp0backend\venv\Scripts\python.exe" ^(
    echo   echo [ERROR] Wala ang backend venv python.exe. Patakbuhin ulit ang setup.bat.
    echo   exit /b 1
    echo ^)
    echo if not exist "%%~dp0backend\venv\pyvenv.cfg" ^(
    echo   echo [ERROR] Incomplete ang backend venv - missing pyvenv.cfg. Patakbuhin ulit ang setup.bat.
    echo   exit /b 1
    echo ^)
    echo echo [WARN] Experimental ito sa Windows kapag Torch/Whisper/CUDA ang gamit. Kapag nag-crash, gamitin ang start_backend.bat.
    echo cd /d "%%~dp0"
    echo "%%~dp0backend\venv\Scripts\python.exe" -m uvicorn server:app --host 0.0.0.0 --port 8000 --reload
  ) > "%REPO_ROOT%\start_backend_dev.bat"
)

if errorlevel 1 (
  call :fail "Hindi ko magawa ang start_backend_dev.bat."
  exit /b 1
)

exit /b 0

:write_start_mobile
if /I "%MOBILE_MODE%"=="nested" (
  (
    echo @echo off
    echo setlocal EnableExtensions
    echo cd /d "%%~dp0mobile"
    echo for /f "usebackq delims=" %%%%I in ^(`powershell -NoProfile -Command "$raw = [string]::Join([Environment]::NewLine, (ipconfig^)^); $blocks = $raw -split '\r?\n\r?\n'; $selected = $null; foreach ^($block in $blocks^) { $ip = [regex]::Match^($block, 'IPv4[^\r\n:]*:\s*([0-9\.]+)'^); $gw = [regex]::Match^($block, 'Default Gateway[^\r\n:]*:\s*([0-9\.]+)'^); if ^($ip.Success -and $gw.Success^) { $candidate = $ip.Groups[1].Value; if ^($candidate -notmatch '^(127|169\.254)\.'^) { $selected = $candidate; break } } }; if ^(-not $selected^) { foreach ^($block in $blocks^) { $ip = [regex]::Match^($block, 'IPv4[^\r\n:]*:\s*([0-9\.]+)'^); if ^($ip.Success^) { $candidate = $ip.Groups[1].Value; if ^($candidate -notmatch '^(127|169\.254)\.'^) { $selected = $candidate; break } } } }; if ^($selected^) { Write-Output $selected }"`^) do set "LOCAL_IP=%%%%I"
    echo if defined LOCAL_IP set "EXPO_PACKAGER_PROXY_URL=http://%%LOCAL_IP%%:8081"
    echo if defined LOCAL_IP echo [INFO] Expo bundle URL forced to exp://%%LOCAL_IP%%:8081
    echo call npx expo start --lan --clear
  ) > "%REPO_ROOT%\start_mobile.bat"
) else (
  (
    echo @echo off
    echo setlocal EnableExtensions
    echo cd /d "%%~dp0"
    echo for /f "usebackq delims=" %%%%I in ^(`powershell -NoProfile -Command "$raw = [string]::Join([Environment]::NewLine, (ipconfig^)^); $blocks = $raw -split '\r?\n\r?\n'; $selected = $null; foreach ^($block in $blocks^) { $ip = [regex]::Match^($block, 'IPv4[^\r\n:]*:\s*([0-9\.]+)'^); $gw = [regex]::Match^($block, 'Default Gateway[^\r\n:]*:\s*([0-9\.]+)'^); if ^($ip.Success -and $gw.Success^) { $candidate = $ip.Groups[1].Value; if ^($candidate -notmatch '^(127|169\.254)\.'^) { $selected = $candidate; break } } }; if ^(-not $selected^) { foreach ^($block in $blocks^) { $ip = [regex]::Match^($block, 'IPv4[^\r\n:]*:\s*([0-9\.]+)'^); if ^($ip.Success^) { $candidate = $ip.Groups[1].Value; if ^($candidate -notmatch '^(127|169\.254)\.'^) { $selected = $candidate; break } } } }; if ^($selected^) { Write-Output $selected }"`^) do set "LOCAL_IP=%%%%I"
    echo if defined LOCAL_IP set "EXPO_PACKAGER_PROXY_URL=http://%%LOCAL_IP%%:8081"
    echo if defined LOCAL_IP echo [INFO] Expo bundle URL forced to exp://%%LOCAL_IP%%:8081
    echo call npx expo start --lan --clear
  ) > "%REPO_ROOT%\start_mobile.bat"
)

if errorlevel 1 (
  call :fail "Hindi ko magawa ang start_mobile.bat."
  exit /b 1
)

exit /b 0

:write_start_mobile_tunnel
if /I "%MOBILE_MODE%"=="nested" (
  (
    echo @echo off
    echo setlocal EnableExtensions
    echo cd /d "%%~dp0mobile"
    echo echo [WARN] Using Expo tunnel mode because LAN mode may fall back to 127.0.0.1 on this Windows setup.
    echo call npx expo start --tunnel --clear
  ) > "%REPO_ROOT%\start_mobile_tunnel.bat"
) else (
  (
    echo @echo off
    echo setlocal EnableExtensions
    echo cd /d "%%~dp0"
    echo echo [WARN] Using Expo tunnel mode because LAN mode may fall back to 127.0.0.1 on this Windows setup.
    echo call npx expo start --tunnel --clear
  ) > "%REPO_ROOT%\start_mobile_tunnel.bat"
)

if errorlevel 1 (
  call :fail "Hindi ko magawa ang start_mobile_tunnel.bat."
  exit /b 1
)

exit /b 0

:verify_backend
set "VERIFY_STDOUT=%BACKEND_CANONICAL%\backend_verify.stdout.log"
set "VERIFY_STDERR=%BACKEND_CANONICAL%\backend_verify.stderr.log"
if exist "%VERIFY_STDOUT%" del /f /q "%VERIFY_STDOUT%" >nul 2>nul
if exist "%VERIFY_STDERR%" del /f /q "%VERIFY_STDERR%" >nul 2>nul

call :info "Checking if SpeakEasy backend answers on http://127.0.0.1:8000/"
call :info "First run may take a while if Whisper Large-V3 still needs to download or warm up."

powershell -NoProfile -Command "$python = '%VENV_PYTHON%'; $workdir = '%BACKEND_APP_DIR%'; $stdoutLog = '%VERIFY_STDOUT%'; $stderrLog = '%VERIFY_STDERR%'; function Test-SpeakEasy { try { $health = Invoke-RestMethod -UseBasicParsing 'http://127.0.0.1:8000/health' -TimeoutSec 3; return ($health.status -eq 'ok') } catch { return $false } }; if (Test-SpeakEasy) { exit 0 }; $proc = Start-Process -FilePath $python -ArgumentList @('-m','uvicorn','server:app','--host','127.0.0.1','--port','8000') -WorkingDirectory $workdir -WindowStyle Hidden -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog -PassThru; try { $ok = $false; for ($i = 0; $i -lt 600; $i++) { Start-Sleep -Seconds 1; if (Test-SpeakEasy) { $ok = $true; break }; if ($proc.HasExited) { break } }; if ($ok) { exit 0 } else { exit 1 } } finally { if ($proc -and (-not $proc.HasExited)) { Stop-Process -Id $proc.Id -Force } }"
if errorlevel 1 (
  call :fail "Backend verification failed. Check %VERIFY_STDERR% and %VERIFY_STDOUT% for details."
  exit /b 1
)

call :info "Backend verification passed on port 8000."
exit /b 0

:success_summary
echo.
echo ============================================================
echo SpeakEasy setup complete.
echo ============================================================
echo Backend URL: http://%LOCAL_IP%:8000
echo Backend check: verified on port 8000
echo.
echo Next steps:
echo   1. Run start_backend.bat
echo   2. Run start_mobile.bat
echo Optional:
echo   - Run start_backend_dev.bat only if you really want --reload hot reload
echo   - Run start_mobile_tunnel.bat if Expo still shows exp://127.0.0.1
echo.
echo Reminder:
echo   - Install Expo Go on your phone
echo   - Make sure phone and PC are on the same WiFi
echo   - If Ollama is not already running, start it with: ollama serve
echo ============================================================
exit /b 0

:step
echo.
echo [STEP] %~1
exit /b 0

:info
echo [INFO] %~1
exit /b 0

:warn
echo [WARN] %~1
exit /b 0

:fail
echo [ERROR] %~1
exit /b 1
