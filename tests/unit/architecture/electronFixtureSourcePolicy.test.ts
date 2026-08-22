import {
    readFile,
    readdir,
} from 'node:fs/promises';
import {join} from 'node:path';
import {
    describe,
    expect,
    it,
} from 'vitest';

const ELECTRON_E2E_SOURCE_ROOT = join(process.cwd(), 'tests/e2e/electron');
const MACHINE_HOME_PATH_PATTERN = /(?:\/Users\/|\/home\/|[A-Za-z]:\\Users\\)[A-Za-z0-9._-]+/u;

async function collectFiles(directory: string): Promise<string[]> {
    const entries = await readdir(directory, {withFileTypes: true});
    const files = await Promise.all(entries.map(async (entry) => {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
            return collectFiles(path);
        }
        return entry.isFile() ? [path] : [];
    }));
    return files.flat();
}

async function readSource(path: string) {
    return readFile(path, 'utf8');
}

describe('Electron E2E fixture source policy', () => {
    it('keeps suite boot, diagnostics, and reset lifecycle ownership explicit', async () => {
        const fixtureSource = await readSource('tests/e2e/electron/helpers/createElectronE2ESessionFixture.ts');
        const sessionSource = await readSource('tests/e2e/electron/helpers/startElectronE2ESession.ts');
        const startBlock = fixtureSource.slice(
            fixtureSource.indexOf('start: async'),
            fixtureSource.indexOf('restart: async'),
        );
        const bootHookBlock = fixtureSource.slice(
            fixtureSource.indexOf('beforeAll(async () =>'),
            fixtureSource.indexOf('beforeEach((context) =>'),
        );
        const resetBlock = sessionSource.slice(
            sessionSource.indexOf('const resetForE2E = async () =>'),
            sessionSource.indexOf('\n\n    return {', sessionSource.indexOf('const resetForE2E = async () =>')),
        );
        const savePreferencesAt = resetBlock.indexOf('settings.save(defaultSettings)');
        const unmountAt = resetBlock.indexOf('about:blank');
        const discardCheckpointAt = resetBlock.indexOf('discardWorkspaceCheckpoint()');
        const clearOriginAt = resetBlock.indexOf('Storage.clearDataForOrigin');
        const cleanupFixturesAt = resetBlock.indexOf('cleanupSessionFixtures(scopedSessionName)');
        const restoreRendererAt = resetBlock.indexOf('page.goto(rendererUrl');
        const rendererReadyAt = resetBlock.indexOf('waitForRendererReady(page)');
        const resumeCheckpointAt = resetBlock.indexOf('resumeWorkspaceCheckpoint(discardToken)');
        const restoreRendererCallAt = resetBlock.indexOf('restoreRendererAndResumeCheckpoint();', clearOriginAt);

        expect(startBlock).not.toContain('if (bootFailure)');
        expect(startBlock).toContain('bootFailure = null;');
        expect(bootHookBlock).toContain('bootFailure = null;');
        expect(fixtureSource).not.toContain('\'[INFRA] boots an Electron session\'');
        expect(fixtureSource).toContain('the suite boot hook may not have completed');
        expect(fixtureSource).toContain('context.onTestFailed');
        expect(fixtureSource).toContain('captureFailureArtifacts');
        expect(fixtureSource).toContain('preserveArtifacts: preserveFailureArtifacts');
        expect(fixtureSource).toContain('await previousSession.stop');
        expect(fixtureSource).toContain('if (clean && !hard)');
        expect(fixtureSource).toContain('async () => stopSingleSession(previousSession.name, {keepNuxt})');
        expect(sessionSource).toContain('page.screenshot');
        expect(sessionSource).toContain('createSessionDiagnostics(sessionName)');
        expect(sessionSource).toContain('join(FAILURE_ARTIFACTS_BASE_DIR, sessionName)');
        expect(sessionSource).toContain('stopOptions.preserveArtifacts');
        expect(sessionSource).toContain('\'electron-user-data\'');
        expect(sessionSource).toContain('prunePreservedSessionArtifacts(scopedSessionName)');
        expect(savePreferencesAt).toBeGreaterThan(-1);
        expect(discardCheckpointAt).toBeGreaterThan(savePreferencesAt);
        expect(unmountAt).toBeGreaterThan(discardCheckpointAt);
        expect(cleanupFixturesAt).toBeGreaterThan(unmountAt);
        expect(clearOriginAt).toBeGreaterThan(cleanupFixturesAt);
        expect(restoreRendererCallAt).toBeGreaterThan(clearOriginAt);
        expect(rendererReadyAt).toBeGreaterThan(restoreRendererAt);
        expect(resumeCheckpointAt).toBeGreaterThan(rendererReadyAt);
        expect(resetBlock).not.toContain('workspace-checkpoint.json');
        expect(resetBlock).not.toContain('claimWorkspaceCheckpoint');
        expect(resetBlock).toContain('installPageEvaluationShims(page)');
        expect(resetBlock).toContain('waitForRendererReady(page)');
    });

    it('keeps blocking-smoke CPU throttling independently recoverable after a test timeout', async () => {
        const smokeSource = await readSource('tests/e2e/electron/prBlockingSmoke.e2e.test.ts');
        const releaseStart = smokeSource.indexOf('async function releaseViewportLifecycleCpuThrottle()');
        const releaseEnd = smokeSource.indexOf('\n    afterEach(async () =>', releaseStart);
        const releaseBlock = smokeSource.slice(releaseStart, releaseEnd);
        const cleanupHookStart = releaseEnd + 1;
        const cleanupHookEnd = smokeSource.indexOf('\n    afterAll(', cleanupHookStart);
        const cleanupHookBlock = smokeSource.slice(cleanupHookStart, cleanupHookEnd);
        const testFinallyStart = smokeSource.indexOf('        } finally {', smokeSource.indexOf(
            'it(\'serializes early Recent navigation and owns every viewport frame\'',
        ));
        const testFinallyEnd = smokeSource.indexOf('\n        }', testFinallyStart) + '\n        }'.length;
        const testFinallyBlock = smokeSource.slice(testFinallyStart, testFinallyEnd);

        expect(releaseBlock).toContain('client.send(\'Emulation.setCPUThrottlingRate\', {rate: 1})');
        expect(releaseBlock).toContain('runBoundedCdpCleanup');
        expect(releaseBlock).toContain('if (viewportLifecycleCpuThrottleRelease)');
        expect(releaseBlock).toContain('return viewportLifecycleCpuThrottleRelease;');
        expect(releaseBlock).toContain('viewportLifecycleCpuThrottleRelease = release;');
        expect(releaseBlock.indexOf('client.send(\'Emulation.setCPUThrottlingRate\', {rate: 1})'))
            .toBeLessThan(releaseBlock.indexOf('client.detach()'));
        expect(cleanupHookBlock).toContain('await releaseViewportLifecycleCpuThrottle();');
        expect(cleanupHookBlock).toContain('sessionName: \'e2e-pr-blocking-timeout-recovery\'');
        expect(cleanupHookBlock).toContain('runBoundedCdpCleanup(\'CPU throttle renderer replacement\'');
        expect(testFinallyBlock.indexOf('releaseViewportLifecycleCpuThrottle()'))
            .toBeLessThan(testFinallyBlock.indexOf('stopCommittedSurfaceSampler(session.page)'));
    });

    it('keeps full-source document matching and single-owner direct-open readiness', async () => {
        const commandHandler = await readSource('scripts/electron-run/createCommandHandler.ts');
        const viewerCore = await readSource('tests/e2e/electron/helpers/viewerCore.ts');
        const recentFilesSuite = await readSource('tests/e2e/electron/recentFiles.e2e.test.ts');
        const sourceWait = viewerCore.slice(
            viewerCore.indexOf('export async function waitForActiveDocumentSource'),
            viewerCore.indexOf('export async function waitForPdfLoaded'),
        );
        const openFlow = viewerCore.slice(
            viewerCore.indexOf('async function openPathInApp'),
            viewerCore.indexOf('export async function triggerOpenPathInApp'),
        );

        expect(commandHandler).toContain('activeDocumentRecord?.tab?.originalPath');
        expect(commandHandler).toContain('isRequestedDocumentLoaded(viewer.documentPath)');
        expect(commandHandler).toContain('viewer.documentPath ?? \'<none>\'');
        expect(sourceWait).toContain('\'originalPath\'');
        expect(sourceWait).toContain('\'pendingDocumentPath\'');
        expect(sourceWait).toContain('normalize(candidate) === requestedPath');
        expect(sourceWait).not.toContain('basename');
        expect(recentFilesSuite).toContain('row.dataset.recentSource === targetSourcePath');
        expect(recentFilesSuite).toContain('two files share a basename');
        expect(openFlow).toContain('isStartupOpenClaimPending?.() === false');
        expect(openFlow).toContain('getActiveTabId?.()');
        expect(openFlow).not.toContain('__evbDocumentOpenShellReadyAt');
        expect(openFlow).not.toContain('performance.now()');
        expect(openFlow).toContain('openTriggered = true');
        expect(openFlow.match(/openTriggered = false/gu)).toHaveLength(1);
        expect(openFlow).toContain('DirectDocumentOpenRejectedError');
        expect(openFlow).not.toContain('openFreshTabForDocumentOpen');
        expect(openFlow).not.toContain('New Tab');
    });

    it('keeps PDF diagnostic work awaited instead of raced against cleanup', async () => {
        const source = await readSource('tests/e2e/electron/prBlockingSmoke.e2e.test.ts');
        const diagnosticStage = source.slice(
            source.indexOf('async function runPdfDiagnosticStage'),
            source.indexOf('async function waitForCommittedEmptyBaseline'),
        );

        expect(diagnosticStage).toContain('const result = await operation();');
        expect(diagnosticStage).not.toContain('Promise.race');
        expect(diagnosticStage).not.toContain('setTimeout');
    });

    it('keeps large-PDF lanes self-provisioning and retry-isolated', async () => {
        const workflow = await readSource('.github/workflows/ci.yml');
        const job = workflow.slice(
            workflow.indexOf('  nightly_electron_e2e_large_pdf:'),
            workflow.indexOf('  nightly_electron_e2e_quarantine:'),
        );
        const packageScripts = JSON.parse(await readSource('package.json')) as {scripts: Record<string, string>};
        const rapidSource = await readSource('tests/e2e/electron/rapidPdfNavigation.e2e.test.ts');
        const blockingSource = await readSource('tests/e2e/electron/prBlockingSmoke.e2e.test.ts');

        expect(job).toContain('pnpm run test:e2e:electron:large');
        expect(packageScripts.scripts['test:e2e:electron:large'])
            .toContain('EVB_E2E_REQUIRE_LARGE_PDF_FIXTURE=1');
        expect(job).not.toContain('generate-large-pdf-e2e-fixture.mjs');
        expect(job).not.toContain('EVB_E2E_LARGE_PDF_FIXTURE');
        expect(job).not.toContain('pnpm exec vitest run --project e2e-large-pdf');
        expect(rapidSource).toContain('createLargeScannedFixturePdf');
        expect(rapidSource).toContain('waitForScannedFixturePageIdentity');
        expect(rapidSource).not.toContain('selectFixtureDescribe');
        expect(rapidSource).not.toContain('EVB_E2E_REQUIRE_PAGE_JUMP_FIXTURE');
        expect(blockingSource).toContain('createLargeScannedFixturePdf');
        expect(blockingSource).toContain('findPdfVirtualizationContractViolations');
        expect(blockingSource).toContain('wheelPdfViewportAndWaitForSettlement');
        expect(blockingSource).toContain('sessionFixture.restart({');
        const cumulativeTestStart = blockingSource.indexOf(
            'it(\'keeps large-PDF opening, virtualization, and repeated reopen within budget\'',
        );
        const interactionTestStart = blockingSource.indexOf(
            'it(\'keeps large-PDF interaction transitions causally stable\'',
        );
        const interactionTestEnd = blockingSource.indexOf(
            'it(\'does not report a delayed render error for a high-zoom current page\'',
            interactionTestStart,
        );
        const cumulativeTestSource = blockingSource.slice(cumulativeTestStart, interactionTestStart);
        const interactionTestSource = blockingSource.slice(interactionTestStart, interactionTestEnd);
        expect(interactionTestStart).toBeGreaterThan(cumulativeTestStart);
        expect(cumulativeTestSource).toContain('retry: 0');
        expect(cumulativeTestSource).toContain('timeout: 240_000');
        expect(
            interactionTestSource.match(/await waitForCommittedSurfaceSamples\(session\.page, \{/gu) ?? [],
        ).toHaveLength(4);
        expect(interactionTestSource.match(/minimumSamples: 10/gu) ?? []).toHaveLength(4);
        expect(interactionTestSource).toContain('horizontalOverflowCheckpoint: \'high-zoom-transition\'');
        expect(blockingSource).not.toContain('createLargeMultiPageTextFixturePdf');
    });

    it('keeps committed-surface sampling self-contained and resilient', async () => {
        const source = await readSource('tests/e2e/electron/helpers/viewerCommittedSurfaceContract.ts');
        const samplerStart = source.indexOf('export async function installCommittedSurfaceSampler');
        const samplerEnd = source.indexOf(
            'export async function markCommittedSurfaceInteractionCheckpoint',
            samplerStart,
        );
        const samplerSource = source.slice(samplerStart, samplerEnd);

        expect(samplerSource).toContain('const browserOwnsPageFrameStyle =');
        expect(samplerSource).toContain('browserOwnsPageFrameStyle(toStyle(pageCanvas))');
        expect(samplerSource).toContain('} finally {');
        expect(samplerSource).toContain('window.requestAnimationFrame(capture)');
        expect(samplerSource).toContain('__committedSurfaceErrors');
        expect(samplerSource).not.toContain('|| ownsPageFrameStyle(');
    });

    it('keeps E2E source and documentation portable and repository-owned', async () => {
        const files = (await collectFiles(ELECTRON_E2E_SOURCE_ROOT)).filter(file => file.endsWith('.ts'));
        const offenders: string[] = [];
        for (const file of files) {
            const match = MACHINE_HOME_PATH_PATTERN.exec(await readSource(file));
            if (match) {
                offenders.push(`${file.replace(`${process.cwd()}/`, '')} (${match[0]})`);
            }
        }
        const readme = await readSource('tests/fixtures/electron/large-pdf-fixtures/README.md');

        expect(files.length).toBeGreaterThan(0);
        expect(offenders).toEqual([]);
        expect(readme).toContain('EVB_E2E_LARGE_PDF_FIXTURE');
        expect(readme).toContain('EVB_E2E_REQUIRE_LARGE_PDF_FIXTURE=1');
        expect(readme).toContain('scripts/generate-large-pdf-e2e-fixture.mjs');
    });

    it('keeps dev, E2E, and diagnostics on distinct entry ownership', async () => {
        const [
            devSupervisor,
            sessionController,
            ephemeralEntry,
            fixture,
            diagnostics,
            diagnosticsAdapter,
            launchOwner,
        ] = await Promise.all([
            readSource('scripts/electron-run/devSupervisor.ts'),
            readSource('scripts/electron-run/sessionController.ts'),
            readSource('scripts/electron-run/ephemeralSessionEntry.ts'),
            readSource('tests/e2e/electron/helpers/startElectronE2ESession.ts'),
            readSource('scripts/diagnostics/runPdfDiagnosticScenario.ts'),
            readSource('scripts/diagnostics/startPdfDiagnosticsElectronSession.ts'),
            readSource('scripts/electron-run/electronLaunch.ts'),
        ]);

        expect(devSupervisor).toContain('@scripts/electron-run/sessionController');
        expect(devSupervisor).toContain('cannot own an ephemeral E2E session');
        expect(sessionController).toContain('@scripts/electron-run/electronLaunch');
        expect(ephemeralEntry).toContain('assertE2ESessionName(sessionName)');
        expect(ephemeralEntry).toContain('@scripts/electron-run/sessionController');
        expect(fixture).toContain('@scripts/electron-run/startSessionDetached');
        expect(fixture).toContain('owner: \'e2e\'');
        expect(diagnostics).toContain('startPdfDiagnosticsElectronSession');
        expect(diagnosticsAdapter).toContain('startElectronE2ESession');
        expect(launchOwner).toContain('export async function launchAutomationSessionWithRecovery');
        expect(fixture).not.toContain('electron-run/devSupervisor');
        expect(diagnostics).not.toContain('electron-run/devSupervisor');
    });
});
