param(
  [string]$TenantId,
  [string]$ClientId,
  [string]$ClientSecret,
  [string]$ProductId = "9N3MB1WJGX1L",
  [string]$AppPackagesDirectory = "store-artifacts",
  [int]$CommitPollSeconds = 300,
  [int]$CommitPollIntervalSeconds = 15,
  [int]$HttpMaxAttempts = 4,
  [int]$HttpRequestTimeoutSeconds = 60,
  [int]$HttpRetryMaxDelaySeconds = 60,
  [switch]$RunContractTests,
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

function Get-SubmissionStatusClassification {
  param([AllowNull()][string]$Status)

  if ([string]::IsNullOrEmpty($Status)) {
    return "Unknown"
  }

  # These are the complete documented application-submission states. A state
  # only counts as accepted once Partner Center has moved past the commit
  # phase. PendingCommit is intentionally polled (and bounded), never accepted.
  switch ($Status) {
    "PendingPublication" { return "Accepted" }
    "PreProcessing" { return "Accepted" }
    "Certification" { return "Accepted" }
    "Release" { return "Accepted" }
    "Publishing" { return "Accepted" }
    "Published" { return "Accepted" }
    "PendingCommit" { return "InProgress" }
    "CommitStarted" { return "InProgress" }
    "None" { return "Failure" }
    "Canceled" { return "Failure" }
    "CommitFailed" { return "Failure" }
    "PreProcessingFailed" { return "Failure" }
    "CertificationFailed" { return "Failure" }
    "ReleaseFailed" { return "Failure" }
    "PublishFailed" { return "Failure" }
    default { return "Unknown" }
  }
}

function Invoke-SubmissionStatusContractTests {
  $expectedClassifications = [ordered]@{
    PendingPublication = "Accepted"
    PreProcessing = "Accepted"
    Certification = "Accepted"
    Release = "Accepted"
    Publishing = "Accepted"
    Published = "Accepted"
    PendingCommit = "InProgress"
    CommitStarted = "InProgress"
    None = "Failure"
    Canceled = "Failure"
    CommitFailed = "Failure"
    PreProcessingFailed = "Failure"
    CertificationFailed = "Failure"
    ReleaseFailed = "Failure"
    PublishFailed = "Failure"
  }

  foreach ($entry in $expectedClassifications.GetEnumerator()) {
    $actual = Get-SubmissionStatusClassification -Status $entry.Key
    if ($actual -ne $entry.Value) {
      throw "Status contract failed for $($entry.Key): expected $($entry.Value), got $actual."
    }
  }

  foreach ($unknownStatus in @($null, "", "UnexpectedStatus")) {
    $actual = Get-SubmissionStatusClassification -Status $unknownStatus
    if ($actual -ne "Unknown") {
      throw "Unknown status contract failed: expected Unknown, got $actual."
    }
  }

  $packageFiles = @(
    [System.IO.FileInfo]::new("EVB-Viewer-current-x64.appx"),
    [System.IO.FileInfo]::new("EVB-Viewer-current-arm64.appx")
  )
  $matchingSubmission = [pscustomobject]@{
    applicationPackages = @(
      [pscustomobject]@{ fileName = "EVB-Viewer-current-arm64.appx"; fileStatus = "PendingUpload" },
      [pscustomobject]@{ fileName = "EVB-Viewer-previous.appx"; fileStatus = "PendingDelete" },
      [pscustomobject]@{ fileName = "EVB-Viewer-current-x64.appx"; fileStatus = "PendingUpload" }
    )
  }
  if (-not (Test-SubmissionMatchesPackageFiles -Submission $matchingSubmission -Packages $packageFiles)) {
    throw "Exact package reconciliation contract failed for a matching submission."
  }
  $matchingSubmission.applicationPackages[0].fileName = "EVB-Viewer-stale-arm64.appx"
  if (Test-SubmissionMatchesPackageFiles -Submission $matchingSubmission -Packages $packageFiles) {
    throw "Exact package reconciliation contract accepted a stale submission."
  }

  $applicationIdentity = [pscustomobject]@{
    pendingApplicationSubmission = [pscustomobject]@{ id = "pending-id" }
    lastPublishedApplicationSubmission = [pscustomobject]@{ id = "published-id" }
  }
  if ((Get-ApplicationSubmissionId -Application $applicationIdentity -PropertyName "pendingApplicationSubmission") -cne "pending-id") {
    throw "Pending submission identity contract failed."
  }
  if ((Get-ApplicationSubmissionId -Application $applicationIdentity -PropertyName "lastPublishedApplicationSubmission") -cne "published-id") {
    throw "Published submission identity contract failed."
  }

  Write-Host "Microsoft Store submission status contract passed."
}

function Get-HttpStatusCode {
  param([System.Management.Automation.ErrorRecord]$ErrorRecord)

  $response = $null
  if ($ErrorRecord.Exception.PSObject.Properties.Name -contains "Response") {
    $response = $ErrorRecord.Exception.Response
  }
  if ($null -eq $response) {
    return $null
  }

  try {
    return [int]$response.StatusCode
  } catch {
    return $null
  }
}

function Test-TransientHttpFailure {
  param([System.Management.Automation.ErrorRecord]$ErrorRecord)

  $statusCode = Get-HttpStatusCode -ErrorRecord $ErrorRecord
  if ($null -eq $statusCode) {
    # DNS, connection-reset, and request-timeout failures do not carry an HTTP
    # response. Retrying them is only permitted for idempotent operations.
    $exception = $ErrorRecord.Exception
    while ($null -ne $exception) {
      if (
        $exception -is [System.Net.Http.HttpRequestException] -or
        $exception -is [System.Net.WebException] -or
        $exception -is [System.TimeoutException] -or
        $exception -is [System.Threading.Tasks.TaskCanceledException] -or
        $exception -is [System.IO.IOException]
      ) {
        return $true
      }
      $exception = $exception.InnerException
    }
    return $false
  }

  return @(408, 425, 429, 500, 502, 503, 504) -contains $statusCode
}

function Get-RetryAfterSeconds {
  param(
    [System.Management.Automation.ErrorRecord]$ErrorRecord,
    [int]$FallbackSeconds,
    [int]$MaximumSeconds
  )

  $response = $null
  if ($ErrorRecord.Exception.PSObject.Properties.Name -contains "Response") {
    $response = $ErrorRecord.Exception.Response
  }
  $rawValue = $null
  if ($null -ne $response) {
    try {
      $rawValue = $response.Headers["Retry-After"]
    } catch {
      $rawValue = $null
    }

    if ($null -eq $rawValue) {
      try {
        $retryAfter = $response.Headers.RetryAfter
        if ($null -ne $retryAfter.Delta) {
          $rawValue = [math]::Ceiling($retryAfter.Delta.TotalSeconds)
        } elseif ($null -ne $retryAfter.Date) {
          $rawValue = $retryAfter.Date.ToString("R")
        }
      } catch {
        $rawValue = $null
      }
    }
  }

  if ($rawValue -is [System.Array]) {
    $rawValue = $rawValue[0]
  }

  $delaySeconds = $FallbackSeconds
  $parsedSeconds = 0
  if ($null -ne $rawValue -and [int]::TryParse([string]$rawValue, [ref]$parsedSeconds)) {
    $delaySeconds = [math]::Max(0, $parsedSeconds)
  } elseif ($null -ne $rawValue) {
    $retryAt = [datetimeoffset]::MinValue
    if ([datetimeoffset]::TryParse([string]$rawValue, [ref]$retryAt)) {
      $delaySeconds = [math]::Max(0, [math]::Ceiling(($retryAt - [datetimeoffset]::UtcNow).TotalSeconds))
    }
  }

  if ($delaySeconds -gt $MaximumSeconds) {
    throw "Server requested a Retry-After delay of $delaySeconds seconds, exceeding the configured $MaximumSeconds-second retry bound."
  }

  return [int]$delaySeconds
}

function Get-BoundedRequestTimeoutSeconds {
  param([AllowNull()][object]$Deadline)

  if ($null -eq $Deadline) {
    return $HttpRequestTimeoutSeconds
  }

  $remainingSeconds = [math]::Floor((([datetime]$Deadline) - (Get-Date)).TotalSeconds)
  if ($remainingSeconds -le 0) {
    throw "The request deadline has elapsed."
  }

  return [int][math]::Max(1, [math]::Min($HttpRequestTimeoutSeconds, $remainingSeconds))
}

function Invoke-WithTransientRetry {
  param(
    [string]$OperationName,
    [scriptblock]$Operation,
    [int]$MaxAttempts,
    [AllowNull()][object]$Deadline = $null
  )

  for ($attempt = 1; $attempt -le $MaxAttempts; $attempt++) {
    try {
      $requestTimeoutSeconds = Get-BoundedRequestTimeoutSeconds -Deadline $Deadline
      return & $Operation $requestTimeoutSeconds
    } catch {
      if ($attempt -ge $MaxAttempts -or -not (Test-TransientHttpFailure -ErrorRecord $_)) {
        throw
      }

      $fallbackSeconds = [math]::Min($HttpRetryMaxDelaySeconds, [math]::Pow(2, $attempt - 1))
      $delaySeconds = Get-RetryAfterSeconds -ErrorRecord $_ -FallbackSeconds $fallbackSeconds -MaximumSeconds $HttpRetryMaxDelaySeconds
      if ($null -ne $Deadline -and (Get-Date).AddSeconds($delaySeconds) -ge [datetime]$Deadline) {
        throw "$OperationName cannot be retried before its deadline."
      }

      $statusCode = Get-HttpStatusCode -ErrorRecord $_
      $statusDescription = if ($null -eq $statusCode) { "transport error" } else { "HTTP $statusCode" }
      Write-Warning "$OperationName failed with $statusDescription; retrying in $delaySeconds second(s) (attempt $($attempt + 1)/$MaxAttempts)."
      if ($delaySeconds -gt 0) {
        Start-Sleep -Seconds $delaySeconds
      }
    }
  }
}

function Invoke-StoreJsonRequest {
  param(
    [string]$Method,
    [string]$Uri,
    [string]$AccessToken,
    [object]$Body = $null,
    [AllowNull()][object]$Deadline = $null
  )

  $headers = @{
    Authorization = "Bearer $AccessToken"
  }

  $json = if ($null -eq $Body) { $null } else { $Body | ConvertTo-Json -Depth 100 }
  $normalizedMethod = $Method.ToUpperInvariant()
  # GET and PUT are idempotent here. Creating or committing a submission is a
  # POST without an idempotency key, so those requests must never be replayed.
  $maxAttempts = if (@("GET", "PUT") -contains $normalizedMethod) { $HttpMaxAttempts } else { 1 }

  return Invoke-WithTransientRetry -OperationName "$normalizedMethod $Uri" -MaxAttempts $maxAttempts -Deadline $Deadline -Operation {
    param([int]$RequestTimeoutSeconds)

    if ($null -eq $json) {
      return Invoke-RestMethod -Method $normalizedMethod -Uri $Uri -Headers $headers -TimeoutSec $RequestTimeoutSeconds
    }

    return Invoke-RestMethod -Method $normalizedMethod -Uri $Uri -Headers $headers -ContentType "application/json" -Body $json -TimeoutSec $RequestTimeoutSeconds
  }
}

function Invoke-StorePackageUpload {
  param(
    [string]$Uri,
    [string]$ZipPath
  )

  return Invoke-WithTransientRetry -OperationName "PUT package upload" -MaxAttempts $HttpMaxAttempts -Operation {
    param([int]$RequestTimeoutSeconds)

    return Invoke-RestMethod -Method Put -Uri $Uri -InFile $ZipPath -ContentType "application/zip" -TimeoutSec $RequestTimeoutSeconds -Headers @{
      "x-ms-blob-type" = "BlockBlob"
    }
  }
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

function Test-SubmissionMatchesPackageFiles {
  param(
    [object]$Submission,
    [System.IO.FileInfo[]]$Packages
  )

  if (-not ($Submission.PSObject.Properties.Name -contains "applicationPackages") -or $null -eq $Submission.applicationPackages) {
    return $false
  }

  $expectedNames = @($Packages | ForEach-Object { $_.Name } | Sort-Object)
  $activeNames = @(
    $Submission.applicationPackages |
      Where-Object {
        -not ($_.PSObject.Properties.Name -contains "fileStatus") -or $_.fileStatus -ne "PendingDelete"
      } |
      ForEach-Object { $_.fileName } |
      Sort-Object
  )

  if ($expectedNames.Count -ne $activeNames.Count) {
    return $false
  }

  return @(Compare-Object -ReferenceObject $expectedNames -DifferenceObject $activeNames -CaseSensitive).Count -eq 0
}

function Get-ApplicationSubmissionId {
  param(
    [object]$Application,
    [string]$PropertyName
  )

  if (
    -not ($Application.PSObject.Properties.Name -contains $PropertyName) -or
    $null -eq $Application.$PropertyName -or
    -not ($Application.$PropertyName.PSObject.Properties.Name -contains "id") -or
    [string]::IsNullOrWhiteSpace($Application.$PropertyName.id)
  ) {
    return $null
  }

  return [string]$Application.$PropertyName.id
}

function Test-SubmissionPackageIdentityMatches {
  param(
    [object]$Submission,
    [object]$ReferenceSubmission
  )

  if (
    -not ($ReferenceSubmission.PSObject.Properties.Name -contains "applicationPackages") -or
    $null -eq $ReferenceSubmission.applicationPackages
  ) {
    return $false
  }

  $referencePackageFiles = @(
    $ReferenceSubmission.applicationPackages |
      Where-Object {
        -not ($_.PSObject.Properties.Name -contains "fileStatus") -or $_.fileStatus -ne "PendingDelete"
      } |
      ForEach-Object { [System.IO.FileInfo]::new([string]$_.fileName) }
  )
  return Test-SubmissionMatchesPackageFiles -Submission $Submission -Packages $referencePackageFiles
}

function Get-SubmissionCreatedAfterTransportFailure {
  param(
    [string]$ApplicationUri,
    [string]$AccessToken,
    [object]$PreCreateApplication
  )

  if ($null -ne (Get-ApplicationSubmissionId -Application $PreCreateApplication -PropertyName "pendingApplicationSubmission")) {
    throw "Cannot reconcile an ambiguous create request because a submission was already pending before the request."
  }

  $baselineId = Get-ApplicationSubmissionId -Application $PreCreateApplication -PropertyName "lastPublishedApplicationSubmission"
  if ([string]::IsNullOrWhiteSpace($baselineId)) {
    throw "Cannot reconcile an ambiguous create request without an exact published-submission baseline."
  }

  $postCreateApplication = Invoke-StoreJsonRequest -Method "Get" -Uri $ApplicationUri -AccessToken $AccessToken
  $postCreateBaselineId = Get-ApplicationSubmissionId -Application $postCreateApplication -PropertyName "lastPublishedApplicationSubmission"
  if ($postCreateBaselineId -cne $baselineId) {
    throw "The published submission changed during an ambiguous create request; refusing to claim any pending draft."
  }

  $pendingId = Get-ApplicationSubmissionId -Application $postCreateApplication -PropertyName "pendingApplicationSubmission"
  if ([string]::IsNullOrWhiteSpace($pendingId)) {
    throw "The create request failed without an HTTP response and Partner Center has no new pending submission to reconcile."
  }

  $baselineSubmission = Invoke-StoreJsonRequest -Method "Get" -Uri "$ApplicationUri/submissions/$baselineId" -AccessToken $AccessToken
  $pendingUri = "$ApplicationUri/submissions/$pendingId"
  $pendingSubmission = Invoke-StoreJsonRequest -Method "Get" -Uri $pendingUri -AccessToken $AccessToken
  $statusResponse = Invoke-StoreJsonRequest -Method "Get" -Uri "$pendingUri/status" -AccessToken $AccessToken
  $status = if ($statusResponse.PSObject.Properties.Name -contains "status") {
    [string]$statusResponse.status
  } else {
    $null
  }

  if ($status -ne "PendingCommit") {
    throw "The submission discovered after an ambiguous create request is in status '$status', not the required pristine PendingCommit state."
  }
  if (-not (Test-SubmissionPackageIdentityMatches -Submission $pendingSubmission -ReferenceSubmission $baselineSubmission)) {
    throw "The submission discovered after an ambiguous create request is not an exact package clone of the unchanged published baseline."
  }

  return [pscustomobject]@{
    Action = "ResumeDraft"
    Id = $pendingId
    Status = $status
    Submission = $pendingSubmission
  }
}

function Get-ReconcilableSubmission {
  param(
    [string]$ApplicationUri,
    [string]$AccessToken,
    [System.IO.FileInfo[]]$Packages,
    [AllowNull()][object]$Application = $null
  )

  $application = $Application
  if ($null -eq $application) {
    $application = Invoke-StoreJsonRequest -Method "Get" -Uri $ApplicationUri -AccessToken $AccessToken
  }
  $candidate = $null
  $candidateKind = $null
  $pendingId = Get-ApplicationSubmissionId -Application $application -PropertyName "pendingApplicationSubmission"
  $publishedId = Get-ApplicationSubmissionId -Application $application -PropertyName "lastPublishedApplicationSubmission"
  if ($null -ne $pendingId) {
    $candidate = $application.pendingApplicationSubmission
    $candidateKind = "pending"
  } elseif ($null -ne $publishedId) {
    $candidate = $application.lastPublishedApplicationSubmission
    $candidateKind = "published"
  } else {
    return $null
  }

  $candidateId = [string]$candidate.id
  $candidateUri = "$ApplicationUri/submissions/$candidateId"
  $candidateSubmission = Invoke-StoreJsonRequest -Method "Get" -Uri $candidateUri -AccessToken $AccessToken
  if (-not (Test-SubmissionMatchesPackageFiles -Submission $candidateSubmission -Packages $Packages)) {
    if ($candidateKind -eq "pending") {
      throw "Partner Center already has pending submission $candidateId, but its active package files do not exactly match this release. Refusing to overwrite or commit a potentially unrelated draft."
    }
    return $null
  }

  $statusResponse = Invoke-StoreJsonRequest -Method "Get" -Uri "$candidateUri/status" -AccessToken $AccessToken
  $status = if ($statusResponse.PSObject.Properties.Name -contains "status") {
    [string]$statusResponse.status
  } else {
    $null
  }
  $classification = Get-SubmissionStatusClassification -Status $status

  if ($classification -eq "Failure") {
    throw "Partner Center $candidateKind submission $candidateId is in failure state $status. Refusing to create a duplicate submission."
  }
  if ($classification -eq "Unknown") {
    throw "Partner Center $candidateKind submission $candidateId returned unknown status '$status'. Refusing to create a duplicate submission."
  }

  $action = if ($classification -eq "Accepted") {
    "AlreadyAccepted"
  } elseif ($status -eq "PendingCommit") {
    "ResumeDraft"
  } elseif ($status -eq "CommitStarted") {
    "ResumePolling"
  } else {
    throw "Partner Center $candidateKind submission $candidateId cannot be reconciled from status '$status'."
  }

  return [pscustomobject]@{
    Action = $action
    Id = $candidateId
    Status = $status
    Submission = $candidateSubmission
  }
}

if ($RunContractTests) {
  Invoke-SubmissionStatusContractTests
  return
}

if ($CommitPollSeconds -le 0) {
  throw "CommitPollSeconds must be greater than zero."
}
if ($CommitPollIntervalSeconds -le 0) {
  throw "CommitPollIntervalSeconds must be greater than zero."
}
if ($HttpMaxAttempts -le 0) {
  throw "HttpMaxAttempts must be greater than zero."
}
if ($HttpRequestTimeoutSeconds -le 0) {
  throw "HttpRequestTimeoutSeconds must be greater than zero."
}
if ($HttpRetryMaxDelaySeconds -le 0) {
  throw "HttpRetryMaxDelaySeconds must be greater than zero."
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
$tokenResponse = Invoke-RestMethod -Method Post -Uri $tokenUri -ContentType "application/x-www-form-urlencoded" -TimeoutSec $HttpRequestTimeoutSeconds -Body @{
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

$preCreateApplication = Invoke-StoreJsonRequest -Method "Get" -Uri $applicationUri -AccessToken $accessToken
$reconciledSubmission = Get-ReconcilableSubmission -ApplicationUri $applicationUri -AccessToken $accessToken -Packages $packages -Application $preCreateApplication
$submissionAction = $null
if ($null -ne $reconciledSubmission) {
  $submission = $reconciledSubmission.Submission
  $submissionId = $reconciledSubmission.Id
  $submissionAction = $reconciledSubmission.Action
  Write-Host "Reconciled Partner Center submission $submissionId in status $($reconciledSubmission.Status)."
} else {
  Write-Host "Creating Partner Center submission draft..."
  try {
    $submission = Invoke-StoreJsonRequest -Method "Post" -Uri "$applicationUri/submissions" -AccessToken $accessToken
    $submissionId = $submission.id
    $submissionAction = "ResumeDraft"
  } catch {
    $creationError = $_
    $creationStatusCode = Get-HttpStatusCode -ErrorRecord $_
    $isAmbiguousTransportFailure = $null -eq $creationStatusCode -and (Test-TransientHttpFailure -ErrorRecord $_)
    if ($creationStatusCode -ne 409 -and -not $isAmbiguousTransportFailure) {
      throw
    }

    if ($isAmbiguousTransportFailure) {
      # The POST cannot be replayed safely. Prove that a pristine draft appeared
      # after our preflight and still clones the unchanged published baseline.
      $reconciledSubmission = Get-SubmissionCreatedAfterTransportFailure -ApplicationUri $applicationUri -AccessToken $accessToken -PreCreateApplication $preCreateApplication
    } else {
      # A concurrent/retried run may have created the draft between our GET and
      # POST. Re-read it and apply the same exact-package reconciliation rules.
      $reconciledSubmission = Get-ReconcilableSubmission -ApplicationUri $applicationUri -AccessToken $accessToken -Packages $packages
    }
    if ($null -eq $reconciledSubmission) {
      throw $creationError
    }
    $submission = $reconciledSubmission.Submission
    $submissionId = $reconciledSubmission.Id
    $submissionAction = $reconciledSubmission.Action
    Write-Host "Reconciled concurrently created Partner Center submission $submissionId in status $($reconciledSubmission.Status)."
  }
}

if ([string]::IsNullOrWhiteSpace($submissionId)) {
  throw "Partner Center did not return a submission ID."
}

if ($submissionAction -eq "AlreadyAccepted") {
  Write-Host "Submission $submissionId already contains exactly these packages and was accepted by Partner Center."
  return
}

$previousPackages = @()
if ($submission.PSObject.Properties.Name -contains "applicationPackages" -and $null -ne $submission.applicationPackages) {
  $desiredPackageNames = @($packages | ForEach-Object { $_.Name })
  $previousPackages = @(
    $submission.applicationPackages |
      Where-Object { $desiredPackageNames -notcontains $_.fileName }
  )
}

$pendingDeletes = @($previousPackages | ForEach-Object { Get-RequiredPackageEntry -Package $_ })
$pendingUploads = @($packages | ForEach-Object { New-PendingUploadPackageEntry -FileName $_.Name })
$nextPackages = @($pendingDeletes + $pendingUploads)
if ($submission.PSObject.Properties.Name -contains "applicationPackages") {
  $submission.applicationPackages = $nextPackages
} else {
  $submission | Add-Member -MemberType NoteProperty -Name "applicationPackages" -Value $nextPackages
}
if (-not (Test-SubmissionMatchesPackageFiles -Submission $submission -Packages $packages)) {
  throw "The reconciled submission package identity does not exactly match the current release."
}

$uploadRoot = $null
$zipPath = $null

try {
  if ($submissionAction -eq "ResumeDraft") {
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
    Invoke-StorePackageUpload -Uri $submission.fileUploadUrl -ZipPath $zipPath | Out-Null

    Write-Host "Committing submission $submissionId..."
    Invoke-StoreJsonRequest -Method "Post" -Uri "$submissionUri/commit" -AccessToken $accessToken | Out-Null
  } else {
    $submissionUri = "$applicationUri/submissions/$submissionId"
  }

  $deadline = (Get-Date).AddSeconds($CommitPollSeconds)
  $status = "not polled"
  while ($true) {
    if ((Get-Date) -ge $deadline) {
      throw "Timed out waiting for submission $submissionId to complete its commit phase. Last status: $status."
    }
    $statusResponse = Invoke-StoreJsonRequest -Method "Get" -Uri "$submissionUri/status" -AccessToken $accessToken -Deadline $deadline
    $status = $statusResponse.status
    $classification = Get-SubmissionStatusClassification -Status $status
    Write-Host "Submission status: $status ($classification)"

    if ($classification -eq "Accepted") {
      Write-Host "Submission $submissionId was accepted by Partner Center."
      break
    }

    if ($classification -eq "Failure") {
      $details = if ($statusResponse.PSObject.Properties.Name -contains "statusDetails") {
        $statusResponse.statusDetails | ConvertTo-Json -Depth 20
      } else {
        "null"
      }
      throw "Partner Center submission failed with status $status. Details: $details"
    }

    if ($classification -eq "Unknown") {
      throw "Partner Center returned an unknown submission status: '$status'."
    }

    $remainingSeconds = [math]::Floor(($deadline - (Get-Date)).TotalSeconds)
    if ($remainingSeconds -le 0) {
      throw "Timed out waiting for submission $submissionId to complete its commit phase. Last status: $status."
    }

    $sleepSeconds = [math]::Min($CommitPollIntervalSeconds, $remainingSeconds)
    Start-Sleep -Seconds $sleepSeconds
  }
} finally {
  if ($null -ne $uploadRoot) {
    Remove-Item -Recurse -Force $uploadRoot -ErrorAction SilentlyContinue
  }
  if ($null -ne $zipPath) {
    Remove-Item -Force $zipPath -ErrorAction SilentlyContinue
  }
}
