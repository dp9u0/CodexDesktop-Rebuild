@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0codex-update.ps1" -Launch %*
