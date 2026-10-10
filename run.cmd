@echo off
setlocal

rem ============================================================
rem  Kogan Mobile data usage report - launcher
rem    run.cmd             generate the report
rem    run.cmd check       verify login / parsing only
rem    run.cmd test        run the offline test suite
rem  (this file is deliberately ASCII-only: cmd.exe mangles
rem   non-ASCII text in .cmd files under legacy code pages)
rem ============================================================

set "ROOT=%~dp0"
cd /d "%ROOT%"

set "NODE_EXE="

rem 1) node on PATH
for %%I in (node.exe) do if not defined NODE_EXE set "NODE_EXE=%%~$PATH:I"

rem 2) usual Node.js install locations
if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles(x86)%\nodejs\node.exe"
if not defined NODE_EXE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE_EXE=%LOCALAPPDATA%\Programs\nodejs\node.exe"

rem 3) Node runtime bundled with the Codex app
if not defined NODE_EXE if exist "%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" set "NODE_EXE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"

rem 4) any other Codex runtime version
if not defined NODE_EXE for /f "delims=" %%F in ('dir /b /s "%USERPROFILE%\.cache\codex-runtimes\node.exe" 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%F"

if not defined NODE_EXE (
  echo [ERROR] Node.js not found.
  echo         Install Node.js LTS from https://nodejs.org/ and run this file again.
  echo.
  pause
  exit /b 1
)

if /i "%~1"=="check" goto :check
if /i "%~1"=="test" goto :test

"%NODE_EXE%" "%ROOT%src\index.js" %*
set "CODE=%ERRORLEVEL%"
if not "%CODE%"=="0" (
  echo.
  echo [exit code %CODE%]
  pause
)
exit /b %CODE%

:check
shift
"%NODE_EXE%" "%ROOT%scripts\check-login.js" %1 %2 %3 %4 %5 %6
exit /b %ERRORLEVEL%

:test
"%NODE_EXE%" "%ROOT%test\run-tests.js"
exit /b %ERRORLEVEL%
