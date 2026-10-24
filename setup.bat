@echo off
title OpsMate — Project Setup Script

echo ==========================================
echo  OpsMate Operations Assistant — Setup
echo ==========================================

echo.
echo [1/7] Checking prerequisites...
echo.

:: Check Node.js
node --version >nul 2>&1
if %errorlevel% neq 0 (
    echo ✘ Node.js not found. Please install Node.js 20+ from https://nodejs.org
    goto :eof
)
echo ✔ Node.js found (v%NODE_VERSION%)

:: Check npm
npm --version >nul 2>&1
if %errorlevel% neq 0 (
    echo ✘ npm not found.
    goto :eof
)
echo ✔ npm found (v%npm_VERSION%)

:: Check Docker
docker --version >nul 2>&1
if %errorlevel% eq 0 (
    echo ✔ Docker found
) else (
    echo ⚠ Docker not found — Docker not required if running locally directly
)

:: Check Ollama
curl --silent --head http://localhost:11434/api/tags 2>/dev/null | find /I "200" >nul 2>&1
if %errorlevel% eq 0 (
    echo ✔ Ollama daemon running at localhost:11434
) else (
    echo ⚠ Ollama daemon not detected at localhost:11434
    echo   Please install: https://ollama.ai && run `ollama serve`
)

echo.
echo [2/7] Installing backend dependencies...
cd backend
if not exist package.json (
    echo ✘ backend/package.json not found
    goto :eof
)
npm install --legacy-peer-deps 2>&1 | find /I "audier" >nul
if %errorlevel% eq 0 (
    echo ✔ Backend dependencies installed
) else (
    echo ⚠ Backend dependencies installed with some warnings
)

echo.
echo [3/7] Installing frontend dependencies...
cd ..\frontend
if not exist package.json (
    echo ✘ frontend/package.json not found
    goto :eof
)
npm install 2>&1 | find /I "audier" >nul
if %errorlevel% eq 0 (
    echo ✔ Frontend dependencies installed
) else (
    echo ⚠ Frontend dependencies installed with some warnings
)

echo.
echo [4/7] Installing MCP dependencies...
cd ..\mcp
if not exist package.json (
    echo ✘ mcp/package.json not found
    goto :eof
)
npm install 2>&1 | find /I "audier" >nul
if %errorlevel% eq 0 (
    echo ✔ MCP dependencies installed
) else (
    echo ⚠ MCP dependencies installed with some warnings
)

echo.
echo [5/7] Configuring environment files...

:: Backend .env
if not exist backend\.env (
    echo   Creating backend\.env from .env.example...
    if exist backend\.env.example (
        copy backend\.env.example backend\.env
        echo   ✔ backend\.env created — please edit with your actual values
    ) else (
        echo   ✘ backend\.env.example not found
    )
) else (
    echo   ✔ backend\.env already exists
)

:: Frontend .env.local
if not exist frontend\.env.local (
    echo   Creating frontend\.env.local from .env.example...
    if exist frontend\.env.example (
        copy frontend\.env.example frontend\.env.local
        echo   ✔ frontend\.env.local created — please edit with your actual values
    ) else (
        echo   ✘ frontend\.env.example not found
    )
) else (
    echo   ✔ frontend\.env.local already exists
)

:: MCP .env
if not exist mcp\.env (
    echo   Creating mcp\.env from .env.example...
    if exist mcp\.env.example (
        copy mcp\.env.example mcp\.env
        echo   ✔ mcp\.env created — please edit with your actual values
    ) else (
        echo   ✘ mcp\.env.example not found
    )
) else (
    echo   ✔ mcp\.env already exists
)

echo.
echo [6/7] Database setup...
echo   Ensure PostgreSQL is running:
echo   - Option A: docker compose up -d postgres (from project root)
echo   - Option B: Run PostgreSQL locally with database `opsmate`, user `opsmate`, password `opsmate_password`
echo.
read /P /N "Has PostgreSQL been set up? (Y/n) " yn
if %yn%==n (
    echo   Skipping — set up PostgreSQL then re-run setup.
    goto :eof
)

echo.
echo [7/7] Verifying Ollama model...
echo   Pulling default model llama3.2:3b...
ollama pull llama3.2:3b 2>&1 | find /I "success" >nul
if %errorlevel% eq 0 (
    echo ✔ Ollama model llama3.2:3b is ready
) else (
    echo ⚠ Ollama model pull may have failed — check Ollama is running
)

echo.
echo ==========================================
echo  Setup complete!
echo ==========================================
echo.
echo Next: run start.bat to start all services, or see README.md for manual steps.
pause