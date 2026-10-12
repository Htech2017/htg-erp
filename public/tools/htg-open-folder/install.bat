@echo off
setlocal
title HTG ERP - Cai dat mo thu muc Google Drive tren may
echo.
echo  Cong cu nay cho phep nut "mo thu muc" trong phan mem HTG ERP mo thang
echo  thu muc Google Drive tren may tinh nay (thay vi mo tren web).
echo  Chi cai cho tai khoan Windows hien tai, khong can quyen quan tri.
echo.
echo  Nhap duong dan thu muc GOC cua he thong tren may nay.
echo  Do la thu muc ben trong co thu muc "Orders".
echo  Vi du:  G:\Shared drives\HTG\ERP     hoac     G:\My Drive\HTG-ERP
echo.
set /p HTGROOT= Duong dan: 
if "%HTGROOT%"=="" ( echo Chua nhap duong dan. & pause & exit /b 1 )
if not exist "%HTGROOT%\" ( echo Khong tim thay thu muc "%HTGROOT%". & pause & exit /b 1 )
if not exist "%HTGROOT%\Orders\" echo  [Luu y] Khong thay thu muc "Orders" ben trong - kiem tra lai neu nut mo khong dung thu muc.

set "DEST=%LOCALAPPDATA%\HTG-OpenFolder"
if not exist "%DEST%" mkdir "%DEST%"
copy /y "%~dp0open-folder.ps1" "%DEST%\open-folder.ps1" >nul
powershell -NoProfile -Command "Set-Content -LiteralPath (Join-Path $env:DEST 'root.txt') -Value $env:HTGROOT -Encoding UTF8"

reg add "HKCU\Software\Classes\htgfolder" /ve /d "URL:HTG ERP mo thu muc" /f >nul
reg add "HKCU\Software\Classes\htgfolder" /v "URL Protocol" /d "" /f >nul
reg add "HKCU\Software\Classes\htgfolder\shell\open\command" /ve /d "\"powershell.exe\" -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File \"%DEST%\open-folder.ps1\" \"%%1\"" /f >nul

echo.
echo  Da cai xong. Duong dan nay phai giong duong dan Admin da nhap o
echo  trang Cai dat he thong cua phan mem:  %HTGROOT%
echo  Lan dau bam nut mo thu muc trong phan mem, chon "Mo tren may".
echo  Lan dau bam nut mo thu muc, trinh duyet se hoi cho phep mo - chon "Luon cho phep".
echo.
pause
