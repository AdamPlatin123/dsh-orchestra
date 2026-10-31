# watch-writer.ps1 — S1-DSH: PowerShell twin of `watch-vs-fstat.mjs --writer` (same line format), so the
# fs.watch / directory-entry check can be repeated with a writer that is not Node.
#   powershell -NoProfile -File watch-writer.ps1 <file> <held|held-fsync|reopen> [seconds=30] [delayMs=3000]
# held        one FileStream kept open, Flush() after each line (data reaches the OS, no FlushFileBuffers)
# held-fsync  same, Flush($true) = FlushFileBuffers after each line
# reopen      open-append-close per line ([IO.File]::AppendAllText)
# Synthetic data only. Prints {"writerPid":..,"mode":..,"lines":..} to stderr at the end.
param([string]$File, [string]$Mode, [int]$Seconds = 30, [int]$DelayMs = 3000)
$dir = [IO.Path]::GetDirectoryName($File)
[void][IO.Directory]::CreateDirectory($dir)
Start-Sleep -Milliseconds $DelayMs
$enc = New-Object System.Text.UTF8Encoding($false)
$pad = 'x' * 170
$fs = $null
if ($Mode -like 'held*') {
  $fs = New-Object IO.FileStream($File, [IO.FileMode]::Append, [IO.FileAccess]::Write, [IO.FileShare]::ReadWrite)
} else {
  [IO.File]::AppendAllText($File, '', $enc)
}
$rnd = New-Object Random
$end = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() + $Seconds * 1000
$i = 0
while ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() -lt $end) {
  $t = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $line = '{"i":' + $i + ',"t":' + $t + ',"pad":"' + $pad + '"}' + "`n"
  $i++
  if ($Mode -eq 'reopen') { [IO.File]::AppendAllText($File, $line, $enc) }
  else {
    $b = $enc.GetBytes($line); $fs.Write($b, 0, $b.Length)
    if ($Mode -eq 'held-fsync') { $fs.Flush($true) } else { $fs.Flush() }
  }
  Start-Sleep -Milliseconds (100 + $rnd.Next(0, 500))
}
if ($fs) { $fs.Close() }
[Console]::Error.WriteLine('{"writerPid":' + $PID + ',"mode":"' + $Mode + '","lines":' + $i + '}')
