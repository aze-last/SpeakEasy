@echo off
setlocal EnableExtensions
cd /d "%~dp0"

for /f "tokens=5" %%P in ('netstat -ano ^| findstr /R /C:":11434 .*LISTENING"') do set "OLLAMA_PORT_PID=%%P"
if defined OLLAMA_PORT_PID (
  echo [ERROR] Port 11434 is already in use by another Ollama process.
  echo [ERROR] Close the existing Ollama desktop app or service first, then rerun this script.
  exit /b 1
)

set "OLLAMA_KV_CACHE_TYPE=q8_0"
echo [INFO] Starting Ollama experiment with OLLAMA_KV_CACHE_TYPE=%OLLAMA_KV_CACHE_TYPE%
start "SpeakEasy Ollama q8_0" cmd /k "set OLLAMA_KV_CACHE_TYPE=%OLLAMA_KV_CACHE_TYPE%&& ollama serve"

timeout /t 2 /nobreak >nul
call "%~dp0start_backend.bat"
