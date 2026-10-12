@echo off
reg delete "HKCU\Software\Classes\htgfolder" /f >nul 2>&1
rmdir /s /q "%LOCALAPPDATA%\HTG-OpenFolder" >nul 2>&1
echo Da go cong cu mo thu muc HTG ERP.
pause
