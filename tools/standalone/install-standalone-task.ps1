# Instala la tarea programada StremioSeeds-Standalone (modo sin tocar server.js).
# - Arranca al iniciar sesión, en oculto, y reintenta si falla.
# - Idempotente: borra la tarea previa con el mismo nombre.
# Uso: powershell -ExecutionPolicy Bypass -File tools\standalone\install-standalone-task.ps1
$ErrorActionPreference = 'Stop'
$TaskName = 'StremioSeeds-Standalone'
$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$Node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $Node) { throw 'No se encontró node en el PATH. Instala Node.js LTS primero.' }
$Action = New-ScheduledTaskAction -Execute $Node -Argument 'index.js' -WorkingDirectory $RepoRoot.Path
$Trigger = New-ScheduledTaskTrigger -AtLogOn
$Settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Settings $Settings -Description 'stremio-seed standalone: vigila stremio-cache y alimenta qBittorrent sin modificar server.js' | Out-Null
Start-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
Write-Output "OK: tarea $TaskName instalada y arrancada desde $($RepoRoot.Path)"
