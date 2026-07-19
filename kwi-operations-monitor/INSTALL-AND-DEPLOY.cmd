@echo off
setlocal EnableExtensions EnableDelayedExpansion
rem ============================================================
rem  KWI Operations Monitor - Windows install + deploy script
rem
rem  Expects the live project at:
rem      C:\kwi-operations-monitor-deploy-ready
rem
rem  Behaviour:
rem    1. Backs up the existing project before replacing files.
rem    2. Clears read-only attributes that would block copying.
rem    3. Copies this script's folder into the project folder
rem       (skipped automatically when the update ZIP was extracted
rem       directly into the project, i.e. source == destination).
rem    4. Validates:  npm.cmd run check   and   node --check public\app.js
rem    5. Deploys:    npx.cmd wrangler deploy
rem    6. Stops on any validation failure; prints the URL on success.
rem ============================================================

set "DEST=C:\kwi-operations-monitor-deploy-ready"
set "SRC=%~dp0"
rem Strip trailing backslash for comparison
if "%SRC:~-1%"=="\" set "SRC=%SRC:~0,-1%"

echo.
echo === KWI Operations Monitor deploy ===
echo Source:      %SRC%
echo Destination: %DEST%
echo.

rem ---- Tooling checks ----------------------------------------
where npm.cmd >nul 2>nul
if errorlevel 1 (
  echo [ERROR] npm.cmd was not found on PATH. Install Node.js from https://nodejs.org first.
  exit /b 1
)
where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] node was not found on PATH. Install Node.js from https://nodejs.org first.
  exit /b 1
)

rem ---- Create destination if missing -------------------------
if not exist "%DEST%" (
  echo Creating %DEST%
  mkdir "%DEST%" || (echo [ERROR] Could not create %DEST% & exit /b 1)
)

rem ---- Detect "extracted in place" (source == destination) ----
set "SAMEDIR=0"
if /I "%SRC%"=="%DEST%" set "SAMEDIR=1"

rem ---- Backup existing project before replacing files ---------
for /f "tokens=1-3 delims=/-. " %%a in ("%DATE%") do set "DSTAMP=%%c%%b%%a"
set "TSTAMP=%TIME::=%"
set "TSTAMP=%TSTAMP:.=%"
set "TSTAMP=%TSTAMP: =0%"
set "BACKUP=%DEST%\..\kwi-monitor-backup-%DSTAMP%-%TSTAMP:~0,6%"
if exist "%DEST%\src\worker.js" (
  echo Backing up current project to: %BACKUP%
  robocopy "%DEST%" "%BACKUP%" /E /XD node_modules .wrangler /XF *.log >nul
  if errorlevel 8 (
    echo [ERROR] Backup failed - aborting before touching the project.
    exit /b 1
  )
) else (
  echo No existing installation found - skipping backup.
)

rem ---- Clear read-only attributes then copy new files ---------
if "%SAMEDIR%"=="1" (
  echo Update ZIP was extracted directly into the project folder - no copy needed.
  attrib -R "%DEST%\*.*" /S /D >nul 2>nul
) else (
  echo Clearing read-only attributes in destination...
  attrib -R "%DEST%\*.*" /S /D >nul 2>nul
  echo Copying project files...
  robocopy "%SRC%" "%DEST%" /E /XD node_modules .wrangler .git /XF *.log >nul
  if errorlevel 8 (
    echo [ERROR] File copy failed.
    exit /b 1
  )
)

cd /d "%DEST%" || (echo [ERROR] Could not enter %DEST% & exit /b 1)

rem ---- Install dependencies ----------------------------------
echo.
echo Installing dependencies (npm install)...
call npm.cmd install
if errorlevel 1 (
  echo [ERROR] npm install failed.
  exit /b 1
)

rem ---- Validation (deployment stops when this fails) ----------
echo.
echo Running validation: npm.cmd run check
call npm.cmd run check
if errorlevel 1 (
  echo.
  echo [ERROR] Validation failed - DEPLOYMENT STOPPED.
  echo Fix the reported problems and run this script again.
  exit /b 1
)

echo.
echo Running frontend syntax check: node --check public\app.js
node --check public\app.js
if errorlevel 1 (
  echo [ERROR] public\app.js failed the syntax check - DEPLOYMENT STOPPED.
  exit /b 1
)

rem ---- Deploy -------------------------------------------------
echo.
echo Deploying with: npx.cmd wrangler deploy
set "DEPLOYLOG=%TEMP%\kwi-deploy-log.txt"
call npx.cmd wrangler deploy > "%DEPLOYLOG%" 2>&1
set "DEPLOYRC=%ERRORLEVEL%"
type "%DEPLOYLOG%"
if not "%DEPLOYRC%"=="0" (
  echo.
  echo [ERROR] wrangler deploy failed. See the output above.
  echo Common fixes:
  echo   - Run: npx.cmd wrangler login
  echo   - Set the KV namespace id in wrangler.jsonc
  echo   - Set the API secret: npx.cmd wrangler secret put KWI_API_AUTH
  exit /b 1
)

echo.
echo === Deployment successful ===
for /f "tokens=* usebackq" %%u in (`findstr /R "https://.*workers.dev" "%DEPLOYLOG%"`) do echo Deployed URL: %%u
echo.
echo Backup of the previous version (if any): %BACKUP%
echo To roll back a bad deploy: npx.cmd wrangler rollback
endlocal
exit /b 0
