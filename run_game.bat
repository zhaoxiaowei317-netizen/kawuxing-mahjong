@echo off
chcp 65001 >nul
title 湖北卡五星麻将 - 电脑版启动器
cd /d "%~dp0"

echo ===============================================================
echo            湖北随州/孝感 卡五星麻将 电脑版
echo ===============================================================
echo.
echo 正在检查运行环境...

where node >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo [错误] 未检测到 Node.js 环境，请先安装 Node.js (https://nodejs.org)
    echo 按任意键退出...
    pause >nul
    exit /b 1
)

echo [OK] Node.js 环境正常。
echo 正在启动本地游戏服务并唤起游戏窗口...
echo.

node desktop_server.js

pause
