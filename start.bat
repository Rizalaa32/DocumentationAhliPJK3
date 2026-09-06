@echo off
title Riksa Uji PJK3 - Server
echo.
echo  ============================================
echo   Riksa Uji PJK3 - Starting Server...
echo  ============================================
echo.

:: Matikan proses lama di port 3000 jika ada
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":3000 " 2^>nul') do (
    taskkill /PID %%a /F >nul 2>&1
)

:: Tunggu sebentar
timeout /t 1 /nobreak >nul

:: Buka browser
start "" "http://localhost:3000"

:: Jalankan server (tampil di window ini)
node server.js
