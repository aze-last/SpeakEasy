@echo off
setlocal EnableExtensions
cd /d "%~dp0"
echo [WARN] Using Expo tunnel mode because LAN mode may fall back to 127.0.0.1 on this Windows setup.
call npx expo start --tunnel --clear
