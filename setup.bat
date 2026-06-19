@echo off
echo ============================================
echo   Air Draw — Setup
echo ============================================
echo.

REM Check for Node.js
node -v >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Node.js is not installed or not on PATH.
    echo         Please install Node.js from https://nodejs.org
    pause
    exit /b 1
)
echo [OK] Node.js found

echo.
echo ============================================
echo   Setup complete!
echo.
echo   Run:  node server.js
echo   Then: open http://localhost:8080
echo.
echo   MediaPipe loads from CDN automatically.
echo ============================================
pause
