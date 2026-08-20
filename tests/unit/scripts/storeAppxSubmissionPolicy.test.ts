import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {
    describe,
    expect,
    it,
} from 'vitest';

async function readProjectFile(filePath: string) {
    return readFile(path.join(process.cwd(), filePath), 'utf8');
}

function powershellFunction(source: string, functionName: string) {
    const start = source.indexOf(`function ${functionName} {\n`);
    if (start === -1) {
        throw new Error(`Missing PowerShell function: ${functionName}`);
    }
    const nextFunction = source.slice(start + 1).search(/\nfunction [A-Za-z][A-Za-z0-9-]+ \{\n/u);
    return nextFunction === -1
        ? source.slice(start)
        : source.slice(start, start + 1 + nextFunction);
}

describe('Microsoft Store submission policy', () => {
    it('classifies every documented status without accepting draft, canceled, or unknown states', async () => {
        const script = await readProjectFile('scripts/release/submit-store-appx.ps1');
        const classifier = powershellFunction(script, 'Get-SubmissionStatusClassification');
        const classifications = Object.fromEntries(
            [...classifier.matchAll(/^\s+"([A-Za-z]+)" \{ return "([A-Za-z]+)" \}$/gmu)]
                .map(match => [
                    match[1],
                    match[2],
                ]),
        );

        expect(classifications).toEqual({
            PendingPublication: 'Accepted',
            PreProcessing: 'Accepted',
            Certification: 'Accepted',
            Release: 'Accepted',
            Publishing: 'Accepted',
            Published: 'Accepted',
            PendingCommit: 'InProgress',
            CommitStarted: 'InProgress',
            None: 'Failure',
            Canceled: 'Failure',
            CommitFailed: 'Failure',
            PreProcessingFailed: 'Failure',
            CertificationFailed: 'Failure',
            ReleaseFailed: 'Failure',
            PublishFailed: 'Failure',
        });
        expect(classifier).toContain('default { return "Unknown" }');
        expect(script).toContain('if ($classification -eq "Unknown")');
        expect(script).toContain('if ($classification -eq "Accepted")');
        expect(script).toContain('if ($classification -eq "Failure")');
        expect(script).toContain('$deadline = (Get-Date).AddSeconds($CommitPollSeconds)');
        expect(script).toContain('if ((Get-Date) -ge $deadline)');
        expect(script).toContain('-Deadline $deadline');
    });

    it('retries only idempotent Store operations and honors bounded Retry-After delays', async () => {
        const script = await readProjectFile('scripts/release/submit-store-appx.ps1');
        const jsonRequest = powershellFunction(script, 'Invoke-StoreJsonRequest');
        const uploadRequest = powershellFunction(script, 'Invoke-StorePackageUpload');
        const retryDelay = powershellFunction(script, 'Get-RetryAfterSeconds');
        const transientFailure = powershellFunction(script, 'Test-TransientHttpFailure');

        expect(jsonRequest).toContain('@("GET", "PUT") -contains $normalizedMethod');
        expect(jsonRequest).toContain('else { 1 }');
        expect(jsonRequest).toContain('-TimeoutSec $RequestTimeoutSeconds');
        expect(uploadRequest).toContain('-MaxAttempts $HttpMaxAttempts');
        expect(uploadRequest).toContain('Invoke-RestMethod -Method Put');
        expect(retryDelay).toContain('$response.Headers["Retry-After"]');
        expect(retryDelay).toContain('[datetimeoffset]::TryParse');
        expect(retryDelay).toContain('exceeding the configured $MaximumSeconds-second retry bound');
        expect(transientFailure).toContain('@(408, 425, 429, 500, 502, 503, 504)');
        expect(transientFailure).toContain('$exception -is [System.Net.Http.HttpRequestException]');
        expect(transientFailure).toContain('return $false');
    });

    it('always removes temporary upload material and executes its contract on Windows CI', async () => {
        const script = await readProjectFile('scripts/release/submit-store-appx.ps1');
        const workflow = await readProjectFile('.github/workflows/store-appx.yml');

        expect(script).toMatch(/\ntry \{[\s\S]+\n\} finally \{/u);
        expect(script).toContain('if ($null -ne $uploadRoot)');
        expect(script).toContain('Remove-Item -Recurse -Force $uploadRoot -ErrorAction SilentlyContinue');
        expect(script).toContain('if ($null -ne $zipPath)');
        expect(script).toContain('Remove-Item -Force $zipPath -ErrorAction SilentlyContinue');
        expect(script).toContain('if ($RunContractTests)');
        expect(workflow).toContain('name: Exercise Store submission status contract');
        expect(workflow).toContain('.\\scripts\\release\\submit-store-appx.ps1 -RunContractTests');
        expect(workflow.match(/persist-credentials: false/gu)).toHaveLength(2);
        expect(workflow).toContain('Microsoft Store submission was requested, but Partner Center credentials are not configured.');
        expect(workflow).toContain('Partial Microsoft Store submission secrets detected; missing: ${missing[*]}');
    });

    it('reconciles exact pending or published packages and refuses unrelated drafts', async () => {
        const script = await readProjectFile('scripts/release/submit-store-appx.ps1');
        const reconciliation = powershellFunction(script, 'Get-ReconcilableSubmission');
        const packageMatch = powershellFunction(script, 'Test-SubmissionMatchesPackageFiles');

        expect(reconciliation).toContain('pendingApplicationSubmission');
        expect(reconciliation).toContain('lastPublishedApplicationSubmission');
        expect(reconciliation).toContain('Test-SubmissionMatchesPackageFiles');
        expect(reconciliation).toContain('Refusing to overwrite or commit a potentially unrelated draft.');
        expect(reconciliation).toContain('"AlreadyAccepted"');
        expect(reconciliation).toContain('"ResumeDraft"');
        expect(reconciliation).toContain('"ResumePolling"');
        expect(packageMatch).toContain('$_.fileStatus -ne "PendingDelete"');
        expect(packageMatch).toContain('@(Compare-Object -ReferenceObject $expectedNames -DifferenceObject $activeNames -CaseSensitive).Count -eq 0');
    });

    it('recovers an ambiguous create response without replaying POST or claiming an unrelated draft', async () => {
        const script = await readProjectFile('scripts/release/submit-store-appx.ps1');
        const recovery = powershellFunction(script, 'Get-SubmissionCreatedAfterTransportFailure');

        expect(recovery).toContain('pendingApplicationSubmission');
        expect(recovery).toContain('lastPublishedApplicationSubmission');
        expect(recovery).toContain('$postCreateBaselineId -cne $baselineId');
        expect(recovery).toContain('$status -ne "PendingCommit"');
        expect(recovery).toContain('Test-SubmissionPackageIdentityMatches');
        expect(recovery).toContain('Action = "ResumeDraft"');
        expect(script).toContain('$isAmbiguousTransportFailure = $null -eq $creationStatusCode');
        expect(script).toContain('Get-SubmissionCreatedAfterTransportFailure');
        expect(script).not.toContain('if ($isAmbiguousTransportFailure) {\n      $submission = Invoke-StoreJsonRequest -Method "Post"');
        expect(script).toContain('The reconciled submission package identity does not exactly match the current release.');
    });
});
