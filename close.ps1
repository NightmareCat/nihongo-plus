Get-NetTCPConnection -LocalPort 4173 -State Listen |
    ForEach-Object { Stop-Process -Id $_.OwningProcess }