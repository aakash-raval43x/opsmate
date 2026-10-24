@echo off
title OpsMate — Start Application

echo ==========================================
echo  OpsMate Operations Assistant — Startup
echo ==========================================

echo.
echo Available startup options:
echo.
echo [1] Docker (recommended — single port 3001)
echo [2] Local development (separate ports: frontend 3001, backend 5000)
echo [3] Backend only (Express API on port 5000)
echo [4] Frontend only (Next.js on port 3001)
echo [5] MCP server only (port 8080)
echo [6] All services via Docker Compose
echo.
read /P /N "Choose option [1-6] " choice

echo.
echo ==========================================
case %choice% in
    1) echo Running Docker setup... ;;
    2) echo Running local dev setup... ;;
    3) echo Starting backend only... ;;
    4) echo Starting frontend only... ;;
    5) echo Starting MCP server only... ;;
    6) echo Starting all services via Docker Compose... ;;
    *) echo Invalid choice; exit /B 1 ;;
esac

echo.

:: ---- Option 1: Docker ----
if %choice% equ 1 (
    echo Starting services via Docker Compose...
    docker compose up --build -d
    echo.
    echo Docker services started.
    echo - Frontend UI: http://localhost:3001
    echo - Backend API: http://localhost:5000 (via Caddy)
    echo - Health check: curl http://localhost:5000/health
    echo.
    echo Waiting for services to be ready...
    timeout /t 5 /nobreak >nul
    curl --silent http://localhost:5000/health 2>nul | find /I "ollama" >nul
    if %errorlevel% eq 0 (
        echo ✔ Backend is healthy (provider=ollama)
    ) else (
        echo ⚠ Backend health check — may take a moment for Ollama to warm up
    )
    goto :eof
)

:: ---- Option 2: Local development ----
if %choice% equ 2 (
    echo Starting backend (port 5000)... cd backend && npm run dev
    cd ..\backend
    echo.
    echo Starting frontend (port 3001)... cd ..\frontend && npm run dev
    cd ..\frontend
    echo.
    echo Make sure PostgreSQL is running:
    echo   docker compose up -d postgres
    echo.
    echo Open http://localhost:3001 in your browser
    goto :eof
)

:: ---- Option 3: Backend only ----
if %choice% equ 3 (
    echo Starting backend on port 5000...
    cd backend
    npm run dev
    goto :eof
)

:: ---- Option 4: Frontend only ----
if %choice% equ 4 (
    echo Starting frontend on port 3001...
    cd frontend
    npm run dev
    goto :eof
)

:: ---- Option 5: MCP server only ----
if %choice% equ 5 (
    echo Starting MCP server...
    cd mcp
    node index.js
    goto :eof
)

:: ---- Option 6: Docker Compose ----
if %choice% equ 6 (
    echo Starting all services via Docker Compose...
    docker compose up --build -d
    echo.
    echo Services started:
    echo - Caddy (reverse proxy): http://localhost:3001
    echo - Frontend: http://localhost:3001
    echo - Backend: http://localhost:5000 (internal)
    echo - PostgreSQL: docker compose up -d postgres
    echo.
    echo Waiting for backend health...
    timeout /t 5 /nobreak >nul
    curl --silent http://localhost:5000/health 2>nul | find /I "ollama" >nul
    if %errorlevel% eq 0 (
        echo ✔ Backend healthy
    ) else (
        echo ⚠ Backend may still be warming up — give it ~30s for Ollama to load
    )
    goto :eof
)

echo.
echo ==========================================
echo Startup complete.
echo ==========================================
pause