import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    mkdir,
    readdir,
    readFile,
    rm,
    stat,
    writeFile,
} from 'node:fs/promises';
import { PDFDocument } from 'pdf-lib';
import { join } from 'node:path';
import { resolveE2EGlobalSetupSessionName } from '@tests/e2e/electron/resolveE2EGlobalSetupSessionName';
import {
    electronUserDataPath,
    sessionDir,
} from '@scripts/electron-run/electronRunSessionPaths';
import {
    E2E_RUN_ID_ENV,
    createE2ERunScopedSessionName,
} from '@scripts/electron-run/electronRunRunId';
import {
    assertE2ESessionName,
    isE2ESessionName,
    selectStaleE2ESessionDirs,
} from '@scripts/electron-run/electronRunE2ESessionPrune';
import {
    prunePreservedSessionArtifacts,
    shouldPreserveE2EArtifacts,
} from '@tests/e2e/electron/helpers/startElectronE2ESession';
import {
    createLargeScannedFixturePdf,
    createMultiPageTextFixturePdf,
    type IFixtureDescribeSelector,
    resolveScannedFixturePageMarkerRgb,
    resolveDjvuFixturePath,
    resolvePathFixtureAvailability,
    selectFixtureDescribe,
} from '@tests/e2e/electron/helpers/fixtures';
import { assertOcrPdfSemanticOutput } from '@tests/e2e/electron/helpers/electronApiHelpers';

const ELECTRON_FIXTURE_ROOT = join(process.cwd(), 'tests/fixtures/electron');
const MAX_TRACKED_ELECTRON_BINARY_FIXTURE_BYTES = 2 * 1024 * 1024;

async function collectFiles(directory: string): Promise<string[]> {
    const entries = await readdir(directory, { withFileTypes: true });
    const files = await Promise.all(entries.map(async (entry) => {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
            return collectFiles(path);
        }
        return entry.isFile() ? [path] : [];
    }));
    return files.flat();
}

function createDescribeSelectorDouble() {
    const skipSelector = ((_name: string, _fn: () => void) => undefined) as IFixtureDescribeSelector;
    skipSelector.skip = skipSelector;

    const selector = ((_name: string, _fn: () => void) => undefined) as IFixtureDescribeSelector;
    selector.skip = skipSelector;
    return selector;
}

describe('Electron E2E fixture policy', () => {
    it('rejects OCR completion artifacts that do not contain the expected semantic text', async () => {
        const outputPath = await createMultiPageTextFixturePdf('unit-ocr-semantic-output.pdf', 1);

        try {
            await expect(assertOcrPdfSemanticOutput(
                outputPath,
                'E2E Multi Page Fixture 1/1',
            )).resolves.toContain('E2E Multi Page Fixture 1/1');
            await expect(assertOcrPdfSemanticOutput(
                outputPath,
                'text that is not present',
            )).rejects.toThrow('OCR output did not contain expected semantic text');
        } finally {
            await rm(outputPath, {force: true});
        }
    });

    it('boots sessions in a suite hook so filtered test-name runs cannot skip initialization', async () => {
        const source = await readFile(
            'tests/e2e/electron/helpers/createElectronE2ESessionFixture.ts',
            'utf8',
        );
        const startBlock = source.slice(
            source.indexOf('start: async'),
            source.indexOf('restart: async'),
        );
        const bootHookBlock = source.slice(
            source.indexOf('beforeAll(async () =>'),
            source.indexOf('beforeEach((context) =>'),
        );

        expect(startBlock).not.toContain('if (bootFailure)');
        expect(startBlock).toContain('bootFailure = null;');
        expect(bootHookBlock).toContain('bootFailure = null;');
        expect(source).not.toContain('\'[INFRA] boots an Electron session\'');
        expect(source).toContain('the suite boot hook may not have completed');
    });

    it('captures and retains session diagnostics when an Electron E2E test fails', async () => {
        const fixtureSource = await readFile(
            'tests/e2e/electron/helpers/createElectronE2ESessionFixture.ts',
            'utf8',
        );
        const sessionSource = await readFile(
            'tests/e2e/electron/helpers/startElectronE2ESession.ts',
            'utf8',
        );

        expect(fixtureSource).toContain('context.onTestFailed');
        expect(fixtureSource).toContain('captureFailureArtifacts');
        expect(fixtureSource).toContain('preserveArtifacts: preserveFailureArtifacts');
        expect(fixtureSource).toContain('await previousSession.stop');
        expect(fixtureSource).toContain('if (clean)');
        expect(fixtureSource).toContain('await stopSingleSession(previousSession.name, {keepNuxt})');
        expect(sessionSource).toContain('page.screenshot');
        expect(sessionSource).toContain('createSessionDiagnostics(sessionName)');
        expect(sessionSource).toContain('join(FAILURE_ARTIFACTS_BASE_DIR, sessionName)');
        expect(sessionSource).toContain('stopOptions.preserveArtifacts');
        expect(sessionSource).toContain('\'electron-user-data\'');
        expect(sessionSource).toContain('prunePreservedSessionArtifacts(scopedSessionName)');
    });

    it('retains bounded failure evidence without keeping Electron profile or app copies', async () => {
        const sessionName = `e2e-unit-retained-artifacts-${process.pid}`;
        const root = sessionDir(sessionName);
        const screenshotPath = join(root, 'screenshots', 'failure.png');
        const logPath = join(root, 'session.log');

        try {
            await mkdir(join(root, 'electron-user-data'), {recursive: true});
            await mkdir(join(root, 'automation-electron-app'), {recursive: true});
            await mkdir(join(root, 'automation-electron-app-entry'), {recursive: true});
            await mkdir(join(root, 'screenshots'), {recursive: true});
            await writeFile(join(root, 'electron-user-data', 'Preferences'), 'profile');
            await writeFile(join(root, 'automation-electron-app', 'Electron'), 'app');
            await writeFile(join(root, 'automation-electron-app-entry', 'main.js'), 'entry');
            await writeFile(screenshotPath, 'screenshot');
            await writeFile(logPath, 'diagnostics');

            prunePreservedSessionArtifacts(sessionName);

            await expect(stat(screenshotPath)).resolves.toBeDefined();
            await expect(stat(logPath)).resolves.toBeDefined();
            await expect(stat(join(root, 'electron-user-data'))).rejects.toMatchObject({code: 'ENOENT'});
            await expect(stat(join(root, 'automation-electron-app'))).rejects.toMatchObject({code: 'ENOENT'});
            await expect(stat(join(root, 'automation-electron-app-entry'))).rejects.toMatchObject({code: 'ENOENT'});
        } finally {
            await rm(root, {
                force: true,
                recursive: true,
            });
        }
    });

    it('recognizes the documented CI artifact-retention values', () => {
        expect(shouldPreserveE2EArtifacts({EVB_E2E_PRESERVE_ARTIFACTS: '1'})).toBe(true);
        expect(shouldPreserveE2EArtifacts({EVB_E2E_PRESERVE_ARTIFACTS: 'yes'})).toBe(true);
        expect(shouldPreserveE2EArtifacts({EVB_E2E_PRESERVE_ARTIFACTS: '0'})).toBe(false);
        expect(shouldPreserveE2EArtifacts({})).toBe(false);
    });

    it('matches openPdf readiness against the workspace document record', async () => {
        const source = await readFile(
            'scripts/electron-run/createCommandHandler.ts',
            'utf8',
        );

        expect(source).toContain('activeDocumentRecord?.tab?.originalPath');
        expect(source).toContain('isRequestedDocumentLoaded(viewer.documentPath)');
        expect(source).toContain('viewer.documentPath ?? \'<none>\'');
    });

    it('matches active and Recent documents by full source identity rather than basename', async () => {
        const viewerCore = await readFile(
            'tests/e2e/electron/helpers/viewerCore.ts',
            'utf8',
        );
        const sourceWait = viewerCore.slice(
            viewerCore.indexOf('export async function waitForActiveDocumentSource'),
            viewerCore.indexOf('export async function waitForPdfLoaded'),
        );
        const recentFilesSuite = await readFile(
            'tests/e2e/electron/recentFiles.e2e.test.ts',
            'utf8',
        );

        expect(sourceWait).toContain('\'originalPath\'');
        expect(sourceWait).toContain('\'pendingDocumentPath\'');
        expect(sourceWait).toContain('normalize(candidate) === requestedPath');
        expect(sourceWait).not.toContain('basename');
        expect(recentFilesSuite).toContain('row.dataset.recentSource === targetSourcePath');
        expect(recentFilesSuite).toContain('two files share a basename');
    });

    it('waits for startup ownership and never retries a slow direct open in a fresh tab', async () => {
        const viewerCore = await readFile(
            'tests/e2e/electron/helpers/viewerCore.ts',
            'utf8',
        );
        const openFlow = viewerCore.slice(
            viewerCore.indexOf('async function openPathInApp'),
            viewerCore.indexOf('export async function triggerOpenPathInApp'),
        );

        expect(openFlow).toContain('isStartupOpenClaimPending?.() === false');
        expect(openFlow).toContain('getActiveTabId?.()');
        expect(openFlow).toContain('__evbDocumentOpenShellReadyAt');
        expect(openFlow).toContain('openTriggered = true');
        expect(openFlow.match(/openTriggered = false/gu)).toHaveLength(1);
        expect(openFlow).toContain('DirectDocumentOpenRejectedError');
        expect(openFlow).not.toContain('openFreshTabForDocumentOpen');
        expect(openFlow).not.toContain('New Tab');
    });

    it('generates a scanned large-PDF fixture without constructing dense text layers', async () => {
        const outputPath = await createLargeScannedFixturePdf(
            'unit-large-scanned-policy.pdf',
            7,
            1024 * 1024,
        );

        try {
            expect((await stat(outputPath)).size).toBeGreaterThan(1024 * 1024);
            const parsed = await PDFDocument.load(await readFile(outputPath), { updateMetadata: false });
            expect(parsed.getPageCount()).toBe(7);
            expect(resolveScannedFixturePageMarkerRgb(1)).not.toEqual(
                resolveScannedFixturePageMarkerRgb(7),
            );
        } finally {
            await rm(outputPath, { force: true });
        }
    });

    it('generates a valid sparse deterministic PDF at an exact requested size', async () => {
        const outputPath = join(process.cwd(), '.devkit/tmp/generated-large-pdf-policy.pdf');
        const { generateLargePdfE2eFixture } = await import('@scripts/generate-large-pdf-e2e-fixture.mjs');
        await mkdir(join(process.cwd(), '.devkit/tmp'), { recursive: true });

        try {
            await generateLargePdfE2eFixture({
                outputPath,
                pageCount: 7,
                targetBytes: 2 * 1024 * 1024,
            });

            expect((await stat(outputPath)).size).toBe(2 * 1024 * 1024);
            const parsed = await PDFDocument.load(await readFile(outputPath), { updateMetadata: false });
            expect(parsed.getPageCount()).toBe(7);
        } finally {
            await rm(outputPath, { force: true });
        }
    });

    it('keeps nightly large-PDF CI required and self-provisioning', async () => {
        const workflow = await readFile('.github/workflows/ci.yml', 'utf8');
        const job = workflow.slice(workflow.indexOf('  nightly_electron_e2e_large_pdf:'), workflow.indexOf('  nightly_electron_e2e_quarantine:'));

        expect(job).toContain('generate-large-pdf-e2e-fixture.mjs');
        expect(job).toContain('EVB_E2E_REQUIRE_LARGE_PDF_FIXTURE=1');
        expect(job).toContain('EVB_E2E_REQUIRE_NATIVE_LARGE_PDF_FIXTURE=1');
        expect(job).toContain('pnpm run test:e2e:electron:large');
        expect(job).not.toContain('pnpm exec vitest run --project e2e-large-pdf');
    });

    it('reports an optional missing fixture once and returns the skipped suite selector', () => {
        const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
        const describeLike = createDescribeSelectorDouble();

        try {
            const fixture = resolvePathFixtureAvailability({
                path: '.devkit/definitely-missing-fixture.pdf',
                label: 'missing unit-test',
                requiredEnvVar: 'EVB_UNIT_REQUIRE_MISSING_FIXTURE',
            });

            const firstSelector = selectFixtureDescribe(describeLike, fixture);
            const secondSelector = selectFixtureDescribe(describeLike, fixture);

            expect(firstSelector).toBe(describeLike.skip);
            expect(secondSelector).toBe(describeLike.skip);
            expect(infoSpy).toHaveBeenCalledTimes(1);
            expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('SKIPPED (fixture missing): missing unit-test fixture does not exist:'));
        } finally {
            infoSpy.mockRestore();
        }
    });

    it('fails during suite selection when the selected lane requires a missing fixture', () => {
        const previousValue = process.env.EVB_UNIT_REQUIRE_MISSING_FIXTURE;
        process.env.EVB_UNIT_REQUIRE_MISSING_FIXTURE = '1';
        const describeLike = createDescribeSelectorDouble();

        try {
            const fixture = resolvePathFixtureAvailability({
                path: '.devkit/definitely-missing-required-fixture.pdf',
                label: 'required unit-test',
                requiredEnvVar: 'EVB_UNIT_REQUIRE_MISSING_FIXTURE',
            });

            expect(() => selectFixtureDescribe(describeLike, fixture)).toThrow(
                /Required fixture missing: required unit-test fixture does not exist:/,
            );
        } finally {
            if (previousValue === undefined) {
                delete process.env.EVB_UNIT_REQUIRE_MISSING_FIXTURE;
            } else {
                process.env.EVB_UNIT_REQUIRE_MISSING_FIXTURE = previousValue;
            }
        }
    });

    it('resolves DjVu smoke through explicit, tracked, or generated deterministic fixtures only', async () => {
        const generatedFixtureFactory = vi.fn(() => {
            throw new Error('the checked-in fixture must make host generators unnecessary');
        });
        const checkedInFixture = resolveDjvuFixturePath({
            env: {},
            generatedFixtureFactory,
        });
        expect(checkedInFixture).toMatchObject({
            path: join(
                process.cwd(),
                'tests',
                'fixtures',
                'djvu',
                'sources',
                'browser-boundary-501-pages.djvu',
            ),
            required: true,
        });
        expect((await stat(checkedInFixture.path!)).size).toBeGreaterThan(0);
        expect(generatedFixtureFactory).not.toHaveBeenCalled();

        const fixture = resolveDjvuFixturePath({
            corpusFixturePath: null,
            devkitFixtureDir: '.devkit/tmp/unit-missing-djvu/devkit',
            env: {},
            generate: false,
            trackedFixtureDir: '.devkit/tmp/unit-missing-djvu/tracked',
        });

        expect(fixture).toMatchObject({
            path: null,
            required: true,
        });
        expect(fixture.reason).toContain('EVB_E2E_DJVU_FIXTURE');
        expect(fixture.reason).toContain('djvu-fixtures/viewer-smoke.djvu');
        expect(fixture.reason).not.toContain('.devkit/pdfs');
        expect(() => selectFixtureDescribe(createDescribeSelectorDouble(), fixture)).toThrow(
            /Required fixture missing: DjVu fixture is not available/u,
        );

        const generatedFixturePath = join(process.cwd(), '.devkit/tmp/unit-missing-djvu/generated.djvu');
        await mkdir(join(process.cwd(), '.devkit/tmp/unit-missing-djvu'), { recursive: true });
        await writeFile(generatedFixturePath, 'generated fixture placeholder');
        try {
            const generated = resolveDjvuFixturePath({
                corpusFixturePath: null,
                devkitFixtureDir: '.devkit/tmp/unit-missing-djvu/devkit',
                env: {},
                generatedFixtureFactory: () => generatedFixturePath,
                trackedFixtureDir: '.devkit/tmp/unit-missing-djvu/tracked',
            });
            expect(generated).toMatchObject({
                path: generatedFixturePath,
                reason: `Using generated DjVu fixture: ${generatedFixturePath}`,
                required: true,
            });
        } finally {
            await rm(join(process.cwd(), '.devkit/tmp/unit-missing-djvu'), {
                force: true,
                recursive: true,
            });
        }
    });

    it('keeps native-preview and DjVu fixture binaries out of tracked oversized fixtures', async () => {
        const files = await collectFiles(ELECTRON_FIXTURE_ROOT);
        const offenders: string[] = [];

        for (const file of files) {
            const relativePath = file.replace(`${ELECTRON_FIXTURE_ROOT}/`, '');
            const size = (await stat(file)).size;
            if (
                /\.(?:pdf|djvu|djv)$/i.test(relativePath)
                && size > MAX_TRACKED_ELECTRON_BINARY_FIXTURE_BYTES
            ) {
                offenders.push(`${relativePath} (${size} bytes)`);
            }
            if (
                /\.(?:djvu|djv)$/i.test(relativePath)
                && !relativePath.startsWith('djvu-fixtures/')
            ) {
                offenders.push(`${relativePath} (DjVu fixtures must live under djvu-fixtures/)`);
            }
            if (
                relativePath.startsWith('large-pdf-fixtures/')
                && !relativePath.endsWith('.md')
            ) {
                offenders.push(`${relativePath} (large native-preview PDFs must stay local-only)`);
            }
        }

        expect(offenders).toEqual([]);
    });

    it('keeps rapid PDF navigation self-sufficient instead of silently skipped', async () => {
        const source = await readFile('tests/e2e/electron/rapidPdfNavigation.e2e.test.ts', 'utf8');

        expect(source).toContain('createLargeScannedFixturePdf');
        expect(source).toContain('waitForScannedFixturePageIdentity');
        expect(source).not.toContain('selectFixtureDescribe');
        expect(source).not.toContain('EVB_E2E_REQUIRE_PAGE_JUMP_FIXTURE');
    });

    it('keeps the blocking large-PDF regression scanned and retry-isolated', async () => {
        const source = await readFile('tests/e2e/electron/prBlockingSmoke.e2e.test.ts', 'utf8');

        expect(source).toContain('createLargeScannedFixturePdf');
        expect(source).toContain('findPdfVirtualizationContractViolations');
        expect(source).toContain('wheelPdfViewportAndWaitForSettlement');
        expect(source).toContain('sessionFixture.restart({');
        expect(source).toContain('it(\'keeps large-PDF interaction transitions causally stable\'');
        const interactionTestStart = source.indexOf('it(\'keeps large-PDF interaction transitions causally stable\'');
        const interactionTestEnd = source.indexOf(
            'it(\'does not report a delayed render error for a high-zoom current page\'',
            interactionTestStart,
        );
        const interactionTestSource = source.slice(interactionTestStart, interactionTestEnd);
        expect(interactionTestStart).toBeGreaterThan(
            source.indexOf('it(\'keeps large-PDF opening, virtualization, and repeated reopen within budget\''),
        );
        expect(interactionTestSource.match(/waitForAnimationFrames\(session\.page, 10\)/gu)).toHaveLength(4);
        expect(interactionTestSource).toContain('horizontalOverflowCheckpoint: \'high-zoom-transition\'');
        expect(source).not.toContain('createLargeMultiPageTextFixturePdf');
    });

    it('keeps the committed-surface browser sampler self-contained and resilient', async () => {
        const source = await readFile(
            'tests/e2e/electron/helpers/viewerCommittedSurfaceContract.ts',
            'utf8',
        );
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

    it('keeps large native preview explicitly opt-in instead of requiring a huge tracked PDF', async () => {
        const source = await readFile('tests/e2e/electron/largePdfNativePreview.e2e.test.ts', 'utf8');

        expect(source).toContain('PDFJS_NATIVE_PREVIEW_MIN_BYTES');
        expect(source).toContain('EVB_E2E_REQUIRE_NATIVE_LARGE_PDF_FIXTURE');
        expect(source).toContain('Set EVB_E2E_LARGE_PDF_FIXTURE to an oversized PDF');
    });
});

describe('Electron E2E deterministic isolation policy', () => {
    it('keeps shared renderer and requested default sessions run-scoped with separate profiles', () => {
        const env = {[E2E_RUN_ID_ENV]: 'coexistence'};
        const sharedRendererSession = resolveE2EGlobalSetupSessionName(env);
        const testSession = createE2ERunScopedSessionName('default', env);

        expect(sharedRendererSession).toBe('e2e-coexistence-shared-renderer');
        expect(testSession).toBe('e2e-coexistence-default');
        expect(isE2ESessionName(sharedRendererSession)).toBe(true);
        expect(isE2ESessionName(testSession)).toBe(true);
        expect(sessionDir(sharedRendererSession)).not.toBe(sessionDir('default'));
        expect(electronUserDataPath(testSession)).not.toBe(electronUserDataPath('default'));
    });

    it('never selects default developer artifacts for stale E2E pruning', () => {
        const selected = selectStaleE2ESessionDirs([
            {
                name: 'default',
                path: sessionDir('default'),
                mtimeMs: 0,
            },
            {
                name: 'e2e-old-run-viewer-smoke',
                path: sessionDir('e2e-old-run-viewer-smoke'),
                mtimeMs: 0,
            },
        ], {
            maxAgeMs: 1,
            nowMs: 10,
        });

        expect(selected.map(candidate => candidate.name)).toEqual(['e2e-old-run-viewer-smoke']);
    });

    it('refuses cleanup against the default developer session', () => {
        expect(() => assertE2ESessionName('default')).toThrow(/refused non-isolated session/u);
        expect(() => prunePreservedSessionArtifacts('default')).toThrow(/refused non-isolated session/u);
        expect(isE2ESessionName('e2e-')).toBe(false);
    });
});
