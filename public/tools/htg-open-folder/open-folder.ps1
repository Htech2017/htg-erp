# HTG ERP - mo thu muc Google Drive tren may tu nut bam trong phan mem.
# Duoc goi boi giao thuc htgfolder://open?path=<duong dan da ma hoa>. Chi mo THU MUC nam trong thu muc goc da khai bao (root.txt).
param([string]$Url)
$ErrorActionPreference = 'Stop'
try {
    if ($Url -notmatch '^htgfolder://open/?\?path=(.+)$') { exit 1 }
    $path = [System.Uri]::UnescapeDataString($Matches[1])
    $root = (Get-Content -LiteralPath (Join-Path $PSScriptRoot 'root.txt') -Encoding UTF8 -TotalCount 1).Trim().TrimEnd('\', '/')
    $full = [System.IO.Path]::GetFullPath($path)
    $rootFull = [System.IO.Path]::GetFullPath($root)
    # Chi cho phep duong dan nam trong thu muc goc (chan viec trang web la mo thu muc / chuong trinh khac)
    if (($full -ne $rootFull) -and (-not $full.StartsWith($rootFull + '\', [System.StringComparison]::OrdinalIgnoreCase))) { exit 2 }
    # Thu muc chua dong bo ve may -> mo thu muc cha gan nhat dang co
    while (-not (Test-Path -LiteralPath $full -PathType Container)) {
        $parent = Split-Path -LiteralPath $full -Parent
        if ((-not $parent) -or ($parent.Length -lt $rootFull.Length)) { exit 3 }
        $full = $parent
    }
    Start-Process -FilePath 'explorer.exe' -ArgumentList ('"' + $full + '"')
} catch { exit 9 }
