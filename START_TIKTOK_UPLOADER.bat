@echo off
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"
title TikTok Carrier Uploader Launcher
chcp 65001 >nul 2>nul

echo ==========================================
echo    TikTok Carrier Uploader Launcher
echo ==========================================
echo.

:: 1. Kiểm tra Node.js & npm
where node >nul 2>nul
if errorlevel 1 (
    echo [LỖI] Chưa cài đặt Node.js hoặc node không nằm trong PATH.
    echo Vui lòng tải Node.js LTS tại: https://nodejs.org/
    pause
    exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
    echo [LỖI] Không tìm thấy npm. Hãy cài lại Node.js LTS kèm theo npm.
    pause
    exit /b 1
)

if not exist package.json (
    echo [LỖI] Không tìm thấy package.json trong thư mục này.
    pause
    exit /b 1
)

:: 2. Tự động tải thư viện cần thiết
echo [SETUP] Đang kiểm tra và cài đặt các thư viện cần thiết (npm install)...
call npm install
if errorlevel 1 (
    echo [LỖI] npm install thất bại. Vui lòng kiểm tra kết nối mạng.
    pause
    exit /b 1
)
echo [OK] Cài đặt thư viện hoàn tất.
echo.

:: 3. Kiểm tra xem có thiếu file quan trọng nào không
echo [CHECK] Đang kiểm tra đầy đủ các file mã nguồn cốt lõi...
node check_files.js
if errorlevel 1 (
    pause
    exit /b 1
)
echo [OK] Đầy đủ file mã nguồn.
echo.

:: 3.5. Kiểm tra kết nối và thư viện Torrent
echo [CHECK] Đang chạy kiểm tra khởi tạo thư viện Torrent (WebTorrent)...
node test_torrent.js
if errorlevel 1 (
    echo [LỖI] WebTorrent kiểm tra thất bại!
    pause
    exit /b 1
)
echo [OK] WebTorrent hoạt động tốt.
echo.

:: 4. Đọc PORT từ file .env nếu có, mặc định là 30001
set PORT=30001
if exist .env (
    for /f "usebackq tokens=1,2 delims==" %%i in (".env") do (
        if "%%i"=="PORT" (
            set PORT=%%j
        )
    )
)

:: 5. Hiển thị thông tin truy cập web
echo ==================================================
echo   🚀 SERVER ĐANG KHỞI CHẠY...
echo   
echo   🌐 Truy cập Dashboard: http://localhost:%PORT%/dashboard/
echo   📺 Truy cập Player:    http://localhost:%PORT%/player
echo ==================================================
echo.

:: 6. Chạy server
node server_extended.js

pause
