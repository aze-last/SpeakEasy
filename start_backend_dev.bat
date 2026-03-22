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
echo [WARN] Experimental ito sa Windows kapag Torch/Whisper/CUDA ang gamit. Kapag nag-crash, gamitin ang start_backend.bat.
cd /d "%~dp0"
"%~dp0backend\venv\Scripts\python.exe" -m uvicorn server:app --host 0.0.0.0 --port 8000 --reload
