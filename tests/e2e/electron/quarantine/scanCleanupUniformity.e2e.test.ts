import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {
    existsSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    rmSync,
    statSync,
    writeFileSync,
} from 'node:fs';
import {
    join,
    resolve,
} from 'node:path';
import {promisify} from 'node:util';
import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    SCAN_CLEANUP_SETTINGS_FILE_NAME,
    createDefaultScanCleanupSettingsFile,
} from '@contracts/scanCleanupSettings';
import {createE2ERunScopedSessionName} from '@scripts/electron-run/electronRunRunId';
import {
    electronUserDataPath,
    sessionDir,
} from '@scripts/electron-run/electronRunSessionPaths';
import {createElectronE2ESessionFixture} from '@tests/e2e/electron/helpers/createElectronE2ESessionFixture';
import {evaluateInPage} from '@tests/e2e/electron/helpers/pageRuntime';
import {
    clickVisibleToolbarButton,
    openPdfInApp,
    waitForPdfLoaded,
    waitForViewerInteractive,
} from '@tests/e2e/electron/helpers/viewerCore';
import type {IWorkspaceExposeProbeWindow} from '@tests/e2e/electron/helpers/workspaceExpose';

interface IWordLossReport {
    pages?: Array<{
        lostCount?: number;
        page?: number;
    }>;
    stampVerification?: {
        payload?: {effectiveOptions?: unknown;};
        status?: string;
    };
}

interface ILevel3StreamHash {
    bytes: number;
    sha256: string;
}

const execFileAsync = promisify(execFile);
const sourcePath = process.env.EVB_SCAN_CLEANUP_UNIFORMITY_SOURCE_PDF ?? '';
const pageCount = Number(process.env.EVB_SCAN_CLEANUP_UNIFORMITY_PAGE_COUNT ?? '0');
const uniformityEnabled = sourcePath !== '' && pageCount > 0;
const sessionName = createE2ERunScopedSessionName('scan-cleanup-uniformity');
const artifactRoot = resolve(
    process.env.EVB_SCAN_CLEANUP_UNIFORMITY_ARTIFACT_DIR
        ?? join(process.cwd(), '.devkit', 'test', 'scan-cleanup-uniformity'),
);
const cliOutputPath = join(artifactRoot, 'cli-cleaned.pdf');
const auditScript = resolve(process.cwd(), 'scripts/diagnostics/scan-cleanup-word-loss-audit.mjs');

const sessionFixture = uniformityEnabled
    ? (() => {
        rmSync(sessionDir(sessionName), {
            force: true,
            recursive: true,
        });
        mkdirSync(electronUserDataPath(sessionName), {recursive: true});
        const settings = createDefaultScanCleanupSettingsFile();
        settings.settings.binarization = 'sauvola';
        settings.settings.firstRunGuidanceDismissed = true;
        writeFileSync(
            join(electronUserDataPath(sessionName), SCAN_CLEANUP_SETTINGS_FILE_NAME),
            `${JSON.stringify(settings, null, 2)}\n`,
            'utf8',
        );
        return createElectronE2ESessionFixture({
            clean: false,
            sessionName,
            timeoutMs: 4_500_000,
            windowMode: 'hidden',
        });
    })()
    : null;

async function runWordLossAudit(name: string, cleanedPath: string) {
    const reportPath = join(artifactRoot, `${name}-word-loss.json`);
    // Only the CLI writes a sibling summary; the app publishes no mapping
    // file, and the audit realigns locally without one.
    const mappingPath = `${cleanedPath}.summary.json`;
    await execFileAsync(process.execPath, [
        auditScript,
        '--source',
        sourcePath,
        '--cleaned',
        cleanedPath,
        ...(existsSync(mappingPath) ? [
            '--mapping',
            mappingPath,
        ] : []),
        '--out',
        reportPath,
        // This probe asserts app/CLI UNIFORMITY (stamp + streams), not word
        // preservation: acceptance2 carries known pre-existing crop-on header
        // losses that would fail --fail-on any identically on both sides.
        '--fail-on',
        'none',
        '--verify-stamp',
        '--workers',
        '1',
    ], {
        cwd: process.cwd(),
        maxBuffer: 4 * 1024 * 1024,
    });
    const report = JSON.parse(readFileSync(reportPath, 'utf8')) as IWordLossReport;
    expect(report.stampVerification?.status, `${name} provenance stamp`).toBe('valid');
    return report;
}

async function collectLevel3StreamHashes(name: string, pdfPath: string) {
    const directory = join(artifactRoot, 'level-3-streams', name);
    mkdirSync(directory, {recursive: true});
    const prefix = join(directory, 'stream');
    await execFileAsync(process.env.EVB_PDFIMAGES_PATH ?? 'pdfimages', [
        '-all',
        pdfPath,
        prefix,
    ], {cwd: process.cwd()});
    const names = readdirSync(directory)
        .filter(fileName => fileName.startsWith('stream-'))
        .sort();
    const hashes = names.map(fileName => {
        const bytes = readFileSync(join(directory, fileName));
        return {
            bytes: bytes.byteLength,
            sha256: createHash('sha256').update(bytes).digest('hex'),
        } satisfies ILevel3StreamHash;
    });
    return hashes.sort((left, right) => (
        `${left.sha256}:${String(left.bytes)}`.localeCompare(`${right.sha256}:${String(right.bytes)}`)
    ));
}

// The automation renderer freezes for minutes at a stretch during document
// open and scan-cleanup classification (no GPU, software raster). A single
// puppeteer waitForFunction rides one CDP call and dies on protocolTimeout,
// so long waits poll with short independent evaluations that tolerate
// protocol errors and outlast the freeze.
async function pollPageUntil(
    label: string,
    timeoutMs: number,
    check: () => Promise<unknown>,
) {
    const deadline = Date.now() + timeoutMs;
    let lastError: unknown = null;
    for (;;) {
        try {
            if (await check()) {
                return;
            }
            lastError = null;
        } catch (error) {
            lastError = error;
        }
        if (Date.now() >= deadline) {
            throw new Error(`Timed out waiting for ${label}${lastError === null ? '' : `: ${String(lastError)}`}`);
        }
        await new Promise(resolveDelay => setTimeout(resolveDelay, 2_000));
    }
}

describe('scan cleanup app/CLI uniformity', () => {
    it.skipIf(!uniformityEnabled)(
        'keeps stamped effective options and Level-3 streams identical',
        async () => {
            expect(sessionFixture).not.toBeNull();
            if (!sessionFixture) {
                return;
            }
            expect(existsSync(sourcePath)).toBe(true);
            expect(statSync(sourcePath).size).toBeGreaterThan(0);
            mkdirSync(artifactRoot, {recursive: true});

            const session = sessionFixture.getSession();
            expect(session).toBeTruthy();
            if (!session) {
                return;
            }
            await openPdfInApp(session.page, sourcePath, 120_000);
            await waitForPdfLoaded(session.page, 120_000);
            await waitForViewerInteractive(session.page, 120_000);
            await pollPageUntil('interactive toolbar with the expected page count', 600_000, () => (
                evaluateInPage(session.page, (expectedPageCount: number) => {
                    const toolbar = (window as IWorkspaceExposeProbeWindow)
                        .__evbTestApi
                        ?.getActiveToolbarSnapshot?.();
                    return toolbar?.initialVisualReady === true
                        && toolbar.viewerCapabilities.pdfMutationActions === true
                        && toolbar.isOpeningDocument === false
                        && toolbar.totalPages === expectedPageCount;
                }, pageCount)
            ));

            await clickVisibleToolbarButton(session.page, 'Scan cleanup');
            await session.page.waitForSelector('.scan-cleanup-surface', {
                timeout: 10_000,
                visible: true,
            });
            // The thumbnail rail is virtualized: it renders only the visible
            // thumbnails, so the classified-overlay count never reaches the
            // document's page count without scrolling. One classified overlay
            // proves classification is live; the enabled primary action is the
            // detection-complete signal (runs wait for terminal detection).
            await pollPageUntil('a classified thumbnail and an enabled run action', 1_800_000, () => (
                evaluateInPage(session.page, () => {
                    const classified = document.querySelectorAll(
                        '.scan-thumbnail-overlay[data-classification]',
                    ).length;
                    const action = document.querySelector<HTMLButtonElement>(
                        '.scan-cleanup-toolbar-primary-action',
                    );
                    return classified >= 1 && Boolean(action) && !action!.disabled;
                })
            ));
            await session.page.click('.scan-cleanup-toolbar-primary-action');
            await pollPageUntil('the cleaned document to replace the source', 2_400_000, () => (
                evaluateInPage(session.page, (source: string) => {
                    const active = (window as IWorkspaceExposeProbeWindow)
                        .__evbTestApi
                        ?.readActiveWorkspaceStateValues?.(['originalPath']);
                    return typeof active?.originalPath === 'string'
                        && active.originalPath !== source
                        && active.originalPath.endsWith('— cleaned.pdf');
                }, sourcePath)
            ));

            const appOutputPath = await session.page.evaluate(() => (
                (window as IWorkspaceExposeProbeWindow)
                    .__evbTestApi
                    ?.readActiveWorkspaceStateValues?.(['originalPath'])?.originalPath
            )) as string;
            expect(existsSync(appOutputPath)).toBe(true);
            expect(statSync(appOutputPath).size).toBeGreaterThan(0);

            await execFileAsync(process.execPath, [
                '--import',
                'tsx',
                'scripts/scan-cleanup-convert.ts',
                '--source',
                sourcePath,
                '--out',
                cliOutputPath,
                '--binarization',
                'sauvola',
                '--parity',
            ], {
                cwd: process.cwd(),
                maxBuffer: 4 * 1024 * 1024,
            });
            expect(existsSync(cliOutputPath)).toBe(true);
            expect(statSync(cliOutputPath).size).toBeGreaterThan(0);

            const [
                appReport,
                cliReport,
            ] = await Promise.all([
                runWordLossAudit('app', appOutputPath),
                runWordLossAudit('cli', cliOutputPath),
            ]);
            expect(appReport.stampVerification?.payload?.effectiveOptions)
                .toEqual(cliReport.stampVerification?.payload?.effectiveOptions);

            const [
                appHashes,
                cliHashes,
            ] = await Promise.all([
                collectLevel3StreamHashes('app', appOutputPath),
                collectLevel3StreamHashes('cli', cliOutputPath),
            ]);
            expect(appHashes.length).toBeGreaterThan(0);
            expect(appHashes).toEqual(cliHashes);
            writeFileSync(
                join(artifactRoot, 'uniformity-report.json'),
                `${JSON.stringify({
                    app: {
                        outputPath: appOutputPath,
                        effectiveOptions: appReport.stampVerification?.payload?.effectiveOptions,
                        level3StreamHashes: appHashes,
                    },
                    cli: {
                        outputPath: cliOutputPath,
                        effectiveOptions: cliReport.stampVerification?.payload?.effectiveOptions,
                        level3StreamHashes: cliHashes,
                    },
                }, null, 2)}\n`,
                'utf8',
            );
        },
        4_500_000,
    );
});
