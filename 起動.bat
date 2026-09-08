@echo off
cd /d "%~dp0"
start "" http://localhost:8995/
python -m http.server 8995
