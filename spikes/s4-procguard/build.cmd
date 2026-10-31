@echo off
rem Builds out\procguard.exe with the system C# compiler (no SDK, no downloads).
setlocal
set CSC=C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe
set HERE=%~dp0
if not exist "%HERE%out" mkdir "%HERE%out"
"%CSC%" /nologo /platform:x64 /optimize /target:exe /r:System.Web.Extensions.dll /r:System.Core.dll /out:"%HERE%out\procguard.exe" "%HERE%ProcGuard.cs"
exit /b %ERRORLEVEL%
