@echo off
rem start-orchestra.cmd - starts orchestrad on your real data in this visible console, then opens
rem http://orchestra.localhost:7470/ in your default browser a few seconds later.
rem
rem   orchestra.cmd --owned --agent-port --peek-port 7470 [your extra arguments]
rem
rem You double-click it yourself. It is never started at logon, by a scheduled task or by any
rem other program: rule dai-2 of the M0 plan (docs/plans/2026-10-31-m0-implementation-plan.md,
rem the row written "dai-2" in Chinese, line 200) says the real profile is started only by you, in a
rem console you can see, and only you pair the page. The pairing code is printed only when
rem stdin and stdout are both this console, so run it from Explorer, cmd, PowerShell or Windows
rem Terminal, not from Git Bash (mintty) and not through a pipe.
rem
rem What to know before you use it:
rem   - The pairing code printed below is good for 10 minutes after the start, and for one browser.
rem     Missed it: press Ctrl+C here and start again.
rem   - Restarting orchestrad loses what lives only in its memory: the conversations of its owned
rem     sessions (a session left running shows state unknown after the restart) and every agent
rem     request still waiting for you.
rem   - Stop it with Ctrl+C in this window.
rem   - Extra arguments are passed on, e.g. --test-profile --test-dir %TEMP%\orchestra-test-x
rem     for the synthetic data. A second --peek-port is refused (duplicate flag).
rem   - start-orchestra.cmd /dry-run prints what it would run and starts nothing.
rem
rem This file is ASCII on purpose: cmd reads a batch file in the console code page, and UTF-8
rem Chinese text in it can break the lines around it. docs/quickstart.md says the same in Chinese.
setlocal
set "ROOT=%~dp0"
set "PAGE=http://orchestra.localhost:7470/"

if /i "%~1"==":open-page" goto open_page

rem node: orchestra.cmd uses ORCHESTRA_NODE, else .tools\node24\node.exe next to it. A git worktree
rem under <main checkout>\.claude\worktrees\<name>\ has no .tools of its own, so look in the main
rem checkout three levels up.
if not defined ORCHESTRA_NODE if not exist "%ROOT%.tools\node24\node.exe" (
  for %%I in ("%ROOT%..\..\..\.tools\node24\node.exe") do if exist "%%~fI" set "ORCHESTRA_NODE=%%~fI"
)
if not defined ORCHESTRA_NODE set "ORCHESTRA_NODE=%ROOT%.tools\node24\node.exe"

if /i "%~1"=="/dry-run" goto dry_run

if not exist "%ORCHESTRA_NODE%" (
  echo start-orchestra: node not found at %ORCHESTRA_NODE% ^(set ORCHESTRA_NODE^)
  echo.
  pause
  exit /b 2
)

rem The page opener runs in its own minimized window, so Ctrl+C here reaches orchestrad only.
start "orchestra page" /min "%~f0" :open-page
call "%ROOT%orchestra.cmd" --owned --agent-port --peek-port 7470 %*
set "RC=%errorlevel%"
echo.
echo start-orchestra: orchestrad exited with code %RC%.
pause
exit /b %RC%

:open_page
rem Wait about 5 seconds for orchestrad to come up, then open the page. If orchestrad refused to
rem start, the page simply does not load; the reason is in the other window.
ping -n 6 127.0.0.1 >nul
start "" "%PAGE%"
exit

:dry_run
echo start-orchestra: dry run, nothing started
echo   node:    %ORCHESTRA_NODE%
if exist "%ORCHESTRA_NODE%" (echo   node found: yes) else (echo   node found: no)
echo   command: "%ROOT%orchestra.cmd" --owned --agent-port --peek-port 7470 %2 %3 %4 %5 %6 %7 %8 %9
echo   page:    %PAGE% ^(opened about 5 seconds after the start^)
exit /b 0
