param(
  [string]$TenantId,
  [string]$ClientId,
  [string]$ClientSecret,
  [string]$ProductId = "9N3MB1WJGX1L",
  [string]$AppPackagesDirectory = "store-artifacts",
  [int]$CommitPollSeconds = 300,
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Assert-NonEmpty {
  param(
    [string]$Name,
    [string]$Value
  )

  if ([string]::IsNullOrWhiteSpace($Value)) {
    throw "$Name is required."
  }
}

function Invoke-StoreJsonRequest {
  param(
    [string]$Method,
    [string]$Uri,
    [string]$AccessToken,
    [object]$Body = $null
  )

  $headers = @{
    Authorization = "Bearer $AccessToken"
  }

  if ($null -eq $Body) {
    return Invoke-RestMethod -Method $Method -Uri $Uri -Headers $headers
  }

  $json = $Body | ConvertTo-Json -Depth 100
  return Invoke-RestMethod -Method $Method -Uri $Uri -Headers $headers -ContentType "application/json" -Body $json
}

function Get-RequiredPackageEntry {
  param([object]$Package)

  $minimumDirectXVersion = "None"
  if ($Package.PSObject.Properties.Name -contains "minimumDirectXVersion" -and -not [string]::IsNullOrWhiteSpace($Package.minimumDirectXVersion)) {
    $minimumDirectXVersion = $Package.minimumDirectXVersion
  }

  $minimumSystemRam = "None"
  if ($Package.PSObject.Properties.Name -contains "minimumSystemRam" -and -not [string]::IsNullOrWhiteSpace($Package.minimumSystemRam)) {
    $minimumSystemRam = $Package.minimumSystemRam
  }

  return [ordered]@{
    fileName = $Package.fileName
    fileStatus = "PendingDelete"
    minimumDirectXVersion = $minimumDirectXVersion
    minimumSystemRam = $minimumSystemRam
  }
}

function New-PendingUploadPackageEntry {
  param([string]$FileName)

  return [ordered]@{
    fileName = $FileName
    fileStatus = "PendingUpload"
    minimumDirectXVersion = "None"
    minimumSystemRam = "None"
  }
}

$packageDirectory = Resolve-Path -Path $AppPackagesDirectory
$packages = @(Get-ChildItem -Path $packageDirectory -Recurse -File -Include "*.appx", "*.msix", "*.msixupload" | Sort-Object -Property Name)

if ($packages.Count -eq 0) {
  throw "No Store package files were found under $packageDirectory."
}

$duplicateNames = @($packages | Group-Object -Property Name | Where-Object { $_.Count -gt 1 })
if ($duplicateNames.Count -gt 0) {
  $names = ($duplicateNames | ForEach-Object { $_.Name }) -join ", "
  throw "Store package file names must be unique inside the submission ZIP. Duplicates: $names"
}

Write-Host "Store product: $ProductId"
Write-Host "Packages selected for Store submission:"
foreach ($package in $packages) {
  Write-Host " - $($package.Name)"
}

if ($DryRun) {
  Write-Host "Dry run complete; no Partner Center submission was created."
  exit 0
}

Assert-NonEmpty -Name "TenantId" -Value $TenantId
Assert-NonEmpty -Name "ClientId" -Value $ClientId
Assert-NonEmpty -Name "ClientSecret" -Value $ClientSecret
Assert-NonEmpty -Name "ProductId" -Value $ProductId

$tokenUri = "https://login.microsoftonline.com/$TenantId/oauth2/token"
$tokenResponse = Invoke-RestMethod -Method Post -Uri $tokenUri -ContentType "application/x-www-form-urlencoded" -Body @{
  grant_type = "client_credentials"
  client_id = $ClientId
  client_secret = $ClientSecret
  resource = "https://manage.devcenter.microsoft.com"
}

if ([string]::IsNullOrWhiteSpace($tokenResponse.access_token)) {
  throw "Partner Center authentication did not return an access token."
}

$accessToken = $tokenResponse.access_token
$applicationUri = "https://manage.devcenter.microsoft.com/v1.0/my/applications/$ProductId"

Write-Host "Creating Partner Center submission draft..."
$submission = Invoke-StoreJsonRequest -Method "Post" -Uri "$applicationUri/submissions" -AccessToken $accessToken
$submissionId = $submission.id

if ([string]::IsNullOrWhiteSpace($submissionId)) {
  throw "Partner Center did not return a submission ID."
}

Write-Host "Created submission draft $submissionId."

$previousPackages = @()
if ($submission.PSObject.Properties.Name -contains "applicationPackages" -and $null -ne $submission.applicationPackages) {
  $previousPackages = @($submission.applicationPackages)
}

$pendingDeletes = @($previousPackages | ForEach-Object { Get-RequiredPackageEntry -Package $_ })
$pendingUploads = @($packages | ForEach-Object { New-PendingUploadPackageEntry -FileName $_.Name })
$nextPackages = @($pendingDeletes + $pendingUploads)
if ($submission.PSObject.Properties.Name -contains "applicationPackages") {
  $submission.applicationPackages = $nextPackages
} else {
  $submission | Add-Member -MemberType NoteProperty -Name "applicationPackages" -Value $nextPackages
}

$uploadRoot = Join-Path -Path ([System.IO.Path]::GetTempPath()) -ChildPath "evb-store-submission-$submissionId"
$zipPath = Join-Path -Path ([System.IO.Path]::GetTempPath()) -ChildPath "evb-store-submission-$submissionId.zip"
Remove-Item -Recurse -Force $uploadRoot -ErrorAction SilentlyContinue
Remove-Item -Force $zipPath -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $uploadRoot | Out-Null

foreach ($package in $packages) {
  Copy-Item -LiteralPath $package.FullName -Destination (Join-Path -Path $uploadRoot -ChildPath $package.Name)
}

Compress-Archive -Path (Join-Path -Path $uploadRoot -ChildPath "*") -DestinationPath $zipPath -Force

Write-Host "Updating submission package list..."
$submissionUri = "$applicationUri/submissions/$submissionId"
Invoke-StoreJsonRequest -Method "Put" -Uri $submissionUri -AccessToken $accessToken -Body $submission | Out-Null

Write-Host "Uploading package ZIP to Partner Center storage..."
Invoke-RestMethod -Method Put -Uri $submission.fileUploadUrl -InFile $zipPath -ContentType "application/zip" -Headers @{
  "x-ms-blob-type" = "BlockBlob"
} | Out-Null

Write-Host "Committing submission $submissionId..."
Invoke-StoreJsonRequest -Method "Post" -Uri "$submissionUri/commit" -AccessToken $accessToken | Out-Null

$deadline = (Get-Date).AddSeconds($CommitPollSeconds)
$terminalFailures = @("CommitFailed", "PreProcessingFailed", "CertificationFailed", "ReleaseFailed", "PublishFailed")

while ($true) {
  $statusResponse = Invoke-StoreJsonRequest -Method "Get" -Uri "$submissionUri/status" -AccessToken $accessToken
  $status = $statusResponse.status
  Write-Host "Submission status: $status"

  if ($terminalFailures -contains $status) {
    $details = $statusResponse.statusDetails | ConvertTo-Json -Depth 20
    throw "Partner Center submission failed with status $status. Details: $details"
  }

  if ($status -ne "CommitStarted") {
    Write-Host "Submission $submissionId was accepted by Partner Center."
    break
  }

  if ((Get-Date) -gt $deadline) {
    throw "Timed out waiting for submission $submissionId to leave CommitStarted."
  }

  Start-Sleep -Seconds 15
}
