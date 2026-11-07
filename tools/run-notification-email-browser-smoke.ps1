$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$smokeId = [guid]::NewGuid().ToString("N")
$tempBase = [System.IO.Path]::GetFullPath($env:TEMP)
$sandboxRoot = [System.IO.Path]::GetFullPath((Join-Path $tempBase "mac-analyzer-notification-smoke-$smokeId"))
$hostRoot = Join-Path $sandboxRoot "host"
$profile = Join-Path $sandboxRoot "edge-profile"
$certPath = Join-Path $sandboxRoot "localhost.crt.pem"
$keyPath = Join-Path $sandboxRoot "localhost.key.pem"
$readyPath = Join-Path $sandboxRoot "smtp-ready.json"
$receiptPath = Join-Path $sandboxRoot "smtp-receipt.json"
$previousSslCertFile = $env:SSL_CERT_FILE
$smtpProcess = $null
$hostProcess = $null
$edgeProcess = $null
$sandboxCreated = $false

function Get-FreeLoopbackPort {
  $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
  $listener.Start()
  try { return ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port }
  finally { $listener.Stop() }
}

try {
  New-Item -ItemType Directory -Path $sandboxRoot | Out-Null
  $sandboxCreated = $true
  New-Item -ItemType Directory -Path $hostRoot | Out-Null

  $rsa = [System.Security.Cryptography.RSA]::Create(2048)
  $request = [System.Security.Cryptography.X509Certificates.CertificateRequest]::new(
    "CN=localhost", $rsa, [System.Security.Cryptography.HashAlgorithmName]::SHA256,
    [System.Security.Cryptography.RSASignaturePadding]::Pkcs1
  )
  $san = [System.Security.Cryptography.X509Certificates.SubjectAlternativeNameBuilder]::new()
  $san.AddDnsName("localhost")
  $san.AddIpAddress([System.Net.IPAddress]::Loopback)
  $request.CertificateExtensions.Add($san.Build())
  $certificate = $request.CreateSelfSigned([DateTimeOffset]::Now.AddMinutes(-5), [DateTimeOffset]::Now.AddDays(1))
  Set-Content -LiteralPath $certPath -Value $certificate.ExportCertificatePem() -Encoding ascii -NoNewline
  Set-Content -LiteralPath $keyPath -Value $rsa.ExportPkcs8PrivateKeyPem() -Encoding ascii -NoNewline
  $certificate.Dispose()
  $rsa.Dispose()

  $python = (Resolve-Path (Join-Path $repoRoot ".codex-release-venv/Scripts/python.exe")).Path
  $server = Join-Path $repoRoot "server.py"
  $smtpSink = Join-Path $repoRoot "tools/local-smtp-sink.py"
  $html = (Resolve-Path (Join-Path $repoRoot "dist/MAC-Analyzer-Pro-Next.html")).Path
  $devtoolsPort = Get-FreeLoopbackPort
  $hostPort = Get-FreeLoopbackPort

  $smtpProcess = Start-Process -FilePath $python -WindowStyle Hidden -PassThru -WorkingDirectory $repoRoot `
    -ArgumentList @($smtpSink, "--port", "0", "--cert", $certPath, "--key", $keyPath, "--ready-file", $readyPath, "--receipt-file", $receiptPath)
  $smtpReady = $null
  for ($attempt = 0; $attempt -lt 100; $attempt++) {
    if (Test-Path -LiteralPath $readyPath) { $smtpReady = Get-Content -LiteralPath $readyPath -Raw | ConvertFrom-Json; break }
    if ($smtpProcess.HasExited) { throw "TLS SMTP sink exited early; see $readyPath in the disposable folder." }
    Start-Sleep -Milliseconds 100
  }
  if (-not $smtpReady -or $smtpReady.host -ne "127.0.0.1" -or $smtpReady.port -lt 1024) { throw "TLS SMTP sink did not report its loopback port." }

  $env:SSL_CERT_FILE = $certPath
  try {
    $hostProcess = Start-Process -FilePath $python -WindowStyle Hidden -PassThru -WorkingDirectory $repoRoot `
      -ArgumentList @($server, "--root", $hostRoot, "--app-file", $html, "--port", "$hostPort", "--shutdown-token", "notification-smoke-$smokeId")
  }
  finally { $env:SSL_CERT_FILE = $previousSslCertFile }

  $health = $null
  for ($attempt = 0; $attempt -lt 100; $attempt++) {
    try { $health = Invoke-RestMethod -Uri "http://127.0.0.1:$hostPort/api/health" -TimeoutSec 2; break }
    catch { if ($hostProcess.HasExited) { throw "Optional host exited before health was ready." }; Start-Sleep -Milliseconds 100 }
  }
  if (-not $health -or $health.status -ne "ok") { throw "Disposable optional host did not become healthy." }

  $edge = Get-Command msedge.exe -ErrorAction SilentlyContinue
  $edgePath = if ($edge) { $edge.Source } else { Join-Path ${env:ProgramFiles(x86)} "Microsoft/Edge/Application/msedge.exe" }
  if (-not (Test-Path -LiteralPath $edgePath)) { throw "Microsoft Edge executable not found: $edgePath" }
  $db = "mac-analyzer-pro-next-test-$smokeId"
  $appUrl = "http://127.0.0.1:$hostPort/MAC-Analyzer-Pro-Next.html?db=$db"
  $edgeProcess = Start-Process -FilePath $edgePath -WindowStyle Hidden -PassThru `
    -ArgumentList @("--headless=new", "--disable-gpu", "--no-first-run", "--remote-allow-origins=*", "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=$devtoolsPort", "--user-data-dir=$profile", "about:blank")
  $devtoolsReady = $false
  for ($attempt = 0; $attempt -lt 100; $attempt++) {
    try { $null = Invoke-RestMethod -Uri "http://127.0.0.1:$devtoolsPort/json/version" -TimeoutSec 2; $devtoolsReady = $true; break }
    catch { if ($edgeProcess.HasExited) { throw "Microsoft Edge exited before DevTools was ready." }; Start-Sleep -Milliseconds 100 }
  }
  if (-not $devtoolsReady) { throw "Microsoft Edge DevTools endpoint did not become ready." }
  & node (Join-Path $repoRoot "tools/browser-smoke.mjs") $devtoolsPort $appUrl --notification-email-loopback-only "--notification-smtp-port=$($smtpReady.port)"
  if ($LASTEXITCODE -ne 0) { throw "Notification browser smoke failed with exit code $LASTEXITCODE." }

  $receipt = $null
  for ($attempt = 0; $attempt -lt 100; $attempt++) {
    if (Test-Path -LiteralPath $receiptPath) { $receipt = Get-Content -LiteralPath $receiptPath -Raw | ConvertFrom-Json; break }
    if ($smtpProcess.HasExited -and $attempt -gt 10) { break }
    Start-Sleep -Milliseconds 100
  }
  $subjectHex = if ($receipt) { [BitConverter]::ToString([Text.Encoding]::UTF8.GetBytes($receipt.subject)).Replace("-", "") } else { "" }
  $bodyHex = if ($receipt) { [BitConverter]::ToString([Text.Encoding]::UTF8.GetBytes($receipt.body)).Replace("-", "") } else { "" }
  if (-not $receipt -or $receipt.sender -ne "sender@example.test" -or $receipt.recipients.Count -ne 1 -or $receipt.recipients[0] -ne "sink@example.test" -or `
    $subjectHex -ne "D0A2D0B5D181D182D0BED0B2D0BED0B520D183D0B2D0B5D0B4D0BED0BCD0BBD0B5D0BDD0B8D0B5204D414320416E616C797A65722050726F204E657874" -or `
    $bodyHex -ne "D094D0B0D0BDD0BDD18BD0B520D0BED0B1D0BED180D183D0B4D0BED0B2D0B0D0BDD0B8D18F20D0BDD0B520D0B2D0BAD0BBD18ED187D0B5D0BDD18B2E") {
    throw "The loopback SMTP sink did not capture the expected synthetic test message."
  }
  [PSCustomObject]@{ ok = $true; channel = "email"; destination = "127.0.0.1 loopback TLS sink"; subject = $receipt.subject; bodyBytes = [Text.Encoding]::UTF8.GetByteCount($receipt.body) } | ConvertTo-Json -Compress
}
finally {
  $env:SSL_CERT_FILE = $previousSslCertFile
  foreach ($process in @($edgeProcess, $hostProcess, $smtpProcess)) {
    if ($process -and -not $process.HasExited) { & taskkill.exe /PID $process.Id /T /F | Out-Null }
  }
  if ($sandboxCreated) {
    $resolved = [System.IO.Path]::GetFullPath($sandboxRoot)
    if ($resolved.StartsWith($tempBase, [System.StringComparison]::OrdinalIgnoreCase) -and $resolved.Contains($smokeId)) {
      Remove-Item -LiteralPath $resolved -Recurse -Force -ErrorAction SilentlyContinue
    }
  }
}
