# Lance Chrome avec le debogage distant (port 9222) en utilisant un profil SEPARE.
# Comme ca le port 9222 est toujours ouvert, meme si ton Chrome habituel tourne.
# Utilisation : .\scripts\launch-chrome-debug.ps1
$chrome = "${env:LOCALAPPDATA}\Google\Chrome\Application\chrome.exe"
if (-not (Test-Path $chrome)) { $chrome = "C:\Program Files\Google\Chrome\Application\chrome.exe" }
if (-not (Test-Path $chrome)) { Write-Host "Chrome non trouve."; exit 1 }

$scriptDir = Split-Path $PSScriptRoot -Parent
$userDataDir = Join-Path $scriptDir ".chrome-debug-profile"
$userDataArg = "--user-data-dir=$userDataDir"

Write-Host "Lancement de Chrome avec le port 9222 (profil dedie : $userDataDir)"
Write-Host "La premiere fois : connecte-toi a TikTok dans cette fenetre. Ensuite garde-la ouverte."
Write-Host ""

Start-Process $chrome -ArgumentList "--remote-debugging-port=9222", $userDataArg
Start-Sleep -Seconds 3

Write-Host "Chrome devrait etre ouvert. Verifie : http://127.0.0.1:9222/json/version (tu dois voir du JSON)."
Write-Host "Dans un autre terminal :"
Write-Host '  cd D:\Who-liked'
Write-Host '  $env:CHROME_DEBUG_URL = "http://127.0.0.1:9222"; npm start'
Write-Host ""
