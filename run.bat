@echo off
cd /d %~dp0

echo ========================================================
echo  ComfyUI Mobile UI - Setup and Run
echo ========================================================

where python >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Python is not installed or not in PATH.
    echo         Install it from https://www.python.org/downloads/
    echo         and make sure to check "Add Python to PATH" during setup.
    pause
    exit /b 1
)

if not exist venv (
    echo [1/3] Creating virtual environment...
    python -m venv venv
) else (
    echo [1/3] Using existing virtual environment.
)

call venv\Scripts\activate.bat
if errorlevel 1 (
    echo [ERROR] Failed to activate virtual environment.
    pause
    exit /b 1
)

echo [2/3] Installing required packages...
python -m pip install --upgrade pip
pip install -r requirements.txt
if errorlevel 1 (
    echo [ERROR] Failed to install packages. Check your internet connection.
    pause
    exit /b 1
)

echo [3/3] Starting server...
echo.
python app.py

pause
