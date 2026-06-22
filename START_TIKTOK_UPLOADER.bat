@echo off
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"
title TikTok Carrier Uploader Launcher
chcp 65001 >nul 2>nul

set "LOG_FILE=%~dp0launcher-last-run.log"
call :log ==========================================
call :log TikTok Carrier Uploader - Setup/Menu
call :log Folder: %CD%
call :log Log file: %LOG_FILE%
call :log ==========================================

where node >nul 2>nul
if errorlevel 1 (
    call :log [LOI] Chua cai Node.js hoac node khong nam trong PATH.
    call :log Tai Node.js LTS tai: https://nodejs.org/
    goto :fail
)

where npm >nul 2>nul
if errorlevel 1 (
    call :log [LOI] Khong tim thay npm. Hay cai lai Node.js LTS kem npm.
    goto :fail
)

call :log [OK] Node:
node --version
node --version >> "%LOG_FILE%" 2>&1
call :log [OK] npm:
call npm --version
call npm --version >> "%LOG_FILE%" 2>&1
call :log

if not exist package.json (
    call :log [LOI] Khong thay package.json. Hay dat file .bat trong thu muc project.
    goto :fail
)

set NEED_INSTALL=0
if not exist node_modules set NEED_INSTALL=1
if not exist node_modules\axios set NEED_INSTALL=1
if not exist node_modules\express set NEED_INSTALL=1
if not exist node_modules\sharp set NEED_INSTALL=1
if not exist node_modules\jsdom set NEED_INSTALL=1
if not exist node_modules\ffmpeg-static set NEED_INSTALL=1

if "%NEED_INSTALL%"=="1" (
    call :log [SETUP] Thieu thu vien Node.js, dang chay npm install...
    call npm install
    if errorlevel 1 (
        call :log [LOI] npm install that bai.
        goto :fail
    )
) else (
    call :log [CHECK] Kiem tra dependency tree bang npm ls...
    call npm ls --depth=0 >> "%LOG_FILE%" 2>&1
    if errorlevel 1 (
        call :log [SETUP] Dependency tree bi thieu/loi, dang chay npm install de sua...
        call npm install
        if errorlevel 1 (
            call :log [LOI] npm install that bai.
            goto :fail
        )
    ) else (
        call :log [OK] node_modules va dependency tree san sang.
    )
)

call :log
call :log [CHECK] Kiem tra cu phap cac file chinh...
for %%F in (launcher.js server.js upload.js tiktok.js public\carrier-player.js public\carrier-worker.js) do (
    call :log   - %%F
    node --check "%%F" >> "%LOG_FILE%" 2>&1
    if errorlevel 1 goto :syntax_error
)
call :log [OK] Syntax check pass.

call :log
call :log [READY] Mo menu quan ly.
call :log
node launcher.js menu
set "NODE_EXIT=%ERRORLEVEL%"
call :log
call :log [INFO] Menu da thoat voi ma %NODE_EXIT%.
if not "%NODE_EXIT%"=="0" goto :fail
goto :end

:syntax_error
call :log [LOI] Kiem tra cu phap that bai. Xem chi tiet trong launcher-last-run.log.
goto :fail

:fail
call :log
call :log [FAILED] Co loi hoac launcher thoat bat thuong. Hay chup man hinh hoac gui file launcher-last-run.log.
goto :end

:end
call :log
call :log Nhan phim bat ky de dong cua so...
pause >nul
exit /b 0

:log
if "%~1"=="" (
    echo.
    echo.>> "%LOG_FILE%"
) else (
    echo %*
    echo %*>> "%LOG_FILE%"
)
exit /b 0
