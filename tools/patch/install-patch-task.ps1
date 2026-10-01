# Instala la tarea StremioSeeds-Repatch: tras cada inicio repone el require en
# server.js si una actualización de Stremio lo borró. Idempotente.
# Uso: powershell -ExecutionPolicy Bypass -File tools\patch\install-patch-task.ps1
# Env opcional: $env:STREMIO_DIR = 'C:\Program Files\Stremio'
$ErrorActionPreference = 'Stop'
$TaskName = 'StremioSeeds-Repatch'
$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$Node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $Node) { throw 'No se encontró node en el PATH. Instala Node.js LTS primero.' }
$PatchJs = Join-Path $RepoRoot.Path 'tools\patch\patch-server.js'
$Action = New-ScheduledTaskAction -Execute $Node -Argument "`"$PatchJs`"" -WorkingDirectory $RepoRoot.Path
$Trigger = New-ScheduledTaskTrigger -AtLogOn
$Settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Settings $Settings -Description 'stremio-seed: repone el hook en server.js tras updates de Stremio' | Out-Null
Write-Output "OK: tarea $TaskName instalada. Ejecuta ahora el parche una vez:"
& $Node $PatchJs
