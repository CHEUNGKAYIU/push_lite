@echo off
echo Starting RSS Push Development Environment...

:: Create data directory if not exists
if not exist "backend\data" mkdir backend\data

:: Start Backend
start cmd /k "cd backend && npm install && node app.js"

:: Start Frontend
start cmd /k "cd frontend && npm install && npm run dev"

echo Backend will run on http://localhost:8000
echo Frontend will run on http://localhost:5173 (with proxy to 8000)
pause
