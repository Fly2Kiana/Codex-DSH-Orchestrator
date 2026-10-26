@echo off
setlocal DisableDelayedExpansion
rem File paths only. Authorization flows directly from Desktop stdout to the helper.
if not defined CODEX_DSH_PIPE_DESKTOP exit /b 2
if not defined CODEX_DSH_PIPE_NODE exit /b 2
if not defined CODEX_DSH_PIPE_HELPER exit /b 2
if not defined CODEX_DSH_PIPE_CALLER exit /b 2
"%CODEX_DSH_PIPE_DESKTOP%" 2>nul | "%CODEX_DSH_PIPE_NODE%" "%CODEX_DSH_PIPE_HELPER%" --caller "%CODEX_DSH_PIPE_CALLER%" 2>&1 | "%CODEX_DSH_PIPE_NODE%" "%~dp0safe-handoff-status.mjs"
