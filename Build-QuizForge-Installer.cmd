@echo off
setlocal
title QuizForge Installer Build
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0core\scripts\build\build-windows-installer.ps1" %*
exit /b %ERRORLEVEL%
