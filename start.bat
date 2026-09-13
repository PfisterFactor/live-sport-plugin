@echo off
title Nuvio Live Sports Plugin

where bun >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] Bun is not installed!
    echo Please install Bun from https://bun.sh/
    pause
    exit /b
)

call bun install || goto :end
call bun run build || goto :end
call bun run start

:end
pause
