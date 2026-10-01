@echo off
REM Ejecuta stremio-seed en modo standalone (sin tocar server.js de Stremio).
REM Sobrevive a las actualizaciones de Stremio.
cd /d "%~dp0..\.."
node index.js
