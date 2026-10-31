@echo off
setlocal
if not defined ORCHESTRA_NODE set "ORCHESTRA_NODE=%~dp0.tools\node24\node.exe"
if not exist "%ORCHESTRA_NODE%" (
  echo orchestra: node not found at %ORCHESTRA_NODE% ^(set ORCHESTRA_NODE^)
  exit /b 2
)
for %%I in ("%ORCHESTRA_NODE%") do set "PATH=%%~dpI;%PATH%"
pushd "%~dp0"
if /i "%~1"=="run" goto run
"%ORCHESTRA_NODE%" src\boot.ts %*
set "RC=%errorlevel%" & popd & exit /b %RC%
:run
"%ORCHESTRA_NODE%" --run %2
set "RC=%errorlevel%" & popd & exit /b %RC%
