import {createHash} from 'node:crypto';
import {
    copyFile,
    mkdir,
    readFile,
    stat,
    writeFile,
} from 'node:fs/promises';
import {dirname} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {
    describe,
    expect,
    it,
} from 'vitest';
import type {Page} from 'puppeteer-core';
import type {TPerformanceMode} from '@contracts/hostResourceProfile';
import {getSessionInfo} from '@scripts/electron-run/electronRunSessionArtifacts';
import {startConfiguredElectronE2ESession as startConfiguredSession} from '@tests/e2e/electron/helpers/startConfiguredElectronE2ESession';
import {
    openAnnotationsTab,
    waitForPdfLoaded,
    waitForViewerInteractive,
} from '@tests/e2e/electron/helpers/viewerCore';
import {createFreeTextAnnotation} from '@tests/e2e/electron/helpers/viewerAnnotations';
import {
    callWorkspaceCommand,
    getLatestAutomationEventId,
    waitForAutomationEvent,
} from '@tests/e2e/electron/helpers/workspaceExpose';
import {readPdfAnnotationSummary} from '@tests/e2e/electron/helpers/fixtures';

const execFileAsync = promisify(execFile);
const benchmarkFixture = process.env.EVB_SAVE_PIPELINE_BENCHMARK_FIXTURE;
const benchmarkOutput = process.env.EVB_SAVE_PIPELINE_BENCHMARK_OUTPUT;
const benchmarkMode = process.env.EVB_SAVE_PIPELINE_BENCHMARK_MODE;
const benchmarkTier = process.env.EVB_SAVE_PIPELINE_BENCHMARK_TIER;
const benchmarkDescribe = benchmarkFixture && benchmarkOutput ? describe : describe.skip;
const SAVE_TIMEOUT_MS = 120_000;

function parsePositiveInteger(value: string | undefined, fallback: number) {
    const parsed = Number.parseInt(value ?? '', 10);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function percentile(values: number[], fraction: number) {
    const sorted = [...values].sort((left, right) => left - right);
    return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
}

async function waitForOpenedPdf(page: Page, path: string) {
    await Promise.all([
        waitForAutomationEvent(page, 'document-opened', {
            path,
            timeoutMs: SAVE_TIMEOUT_MS,
        }),
        waitForAutomationEvent(page, 'first-page-rendered', {
            path,
            timeoutMs: SAVE_TIMEOUT_MS,
        }),
    ]);
    await waitForPdfLoaded(page, SAVE_TIMEOUT_MS);
    await waitForViewerInteractive(page, SAVE_TIMEOUT_MS);
    await openAnnotationsTab(page, SAVE_TIMEOUT_MS);
}

async function forceSerializedFallback(page: Page) {
    await page.evaluate(() => {
        const notApplied = async () => ({
            applied: false,
            validation: null,
        });
        const capabilities = [window.electronAPI?.documentFiles];
        for (const capability of capabilities) {
            if (!capability) {
                continue;
            }
            capability.applyPdfNativeMutationsToWorkingCopy = notApplied;
            capability.savePdfNativeMutations = notApplied;
            capability.savePdfNoteChanges = notApplied;
            capability.savePdfNoteTextUpdates = notApplied;
        }
    });
}

async function runSave(page: Page, path: string, text: string) {
    expect(await createFreeTextAnnotation(page, text)).toBeGreaterThan(0);
    const afterEventId = await getLatestAutomationEventId(page);
    const committed = waitForAutomationEvent(page, 'save-committed', {
        afterEventId,
        path,
        timeoutMs: SAVE_TIMEOUT_MS,
    });
    const beforeBytes = (await stat(path)).size;
    const timestamp = new Date().toISOString();
    const startedAt = performance.now();
    const result = await callWorkspaceCommand<boolean>(page, 'handleSave');
    const durationMs = performance.now() - startedAt;
    expect(result).toEqual({
        called: true,
        value: true,
    });
    await committed;
    const afterBytes = (await stat(path)).size;
    return {
        afterBytes,
        beforeBytes,
        durationMs,
        timestamp,
    };
}

async function readResidentBytes(pid: number | null) {
    if (!pid || process.platform === 'win32') {
        return null;
    }
    try {
        const {stdout} = await execFileAsync('ps', [
            '-o',
            'rss=',
            '-p',
            String(pid),
        ], {encoding: 'utf8'});
        const kib = Number.parseInt(stdout.trim(), 10);
        return Number.isFinite(kib) ? kib * 1024 : null;
    } catch {
        return null;
    }
}

benchmarkDescribe('Electron E2E - save pipeline benchmark', () => {
    it('records repeated real-app saves in an isolated headless session', async () => {
        const mode = benchmarkMode === 'serialized-fallback'
            ? benchmarkMode
            : 'native-freetext';
        const tier: TPerformanceMode = benchmarkTier === 'low'
            ? 'low'
            : 'high';
        const warmups = parsePositiveInteger(
            process.env.EVB_SAVE_PIPELINE_BENCHMARK_WARMUPS,
            5,
        );
        const iterations = parsePositiveInteger(
            process.env.EVB_SAVE_PIPELINE_BENCHMARK_ITERATIONS,
            10,
        );
        const fixturePath = benchmarkFixture!;
        const outputPath = benchmarkOutput!;
        const workingFixture = `${outputPath}.${mode}-${tier}.pdf`;
        await mkdir(dirname(outputPath), {recursive: true});
        await copyFile(fixturePath, workingFixture);
        const inputBytes = (await stat(workingFixture)).size;
        process.env.EVB_PDF_PAGE_OPS_ENABLE = mode === 'native-freetext' ? '1' : '0';
        process.env.EVB_LARGE_PDF_SAVE_OPTIMIZE_MIN_BYTES = '1';

        const session = await startConfiguredSession(
            `e2e-save-benchmark-${mode}-${tier}-${Date.now()}`,
            tier,
            [workingFixture],
        );
        try {
            await waitForOpenedPdf(session.page, workingFixture);
            const hostProfile = await session.page.evaluate(() => (
                window.electronAPI?.host.getResourceProfile() ?? null
            ));
            expect(hostProfile).toMatchObject({tier});
            if (mode === 'serialized-fallback') {
                await forceSerializedFallback(session.page);
            }
            const totalRuns = warmups + iterations;
            const timings: number[] = [];
            const iterationMeasurements = [];
            let peakRssBytes: number | null = null;
            for (let index = 0; index < totalRuns; index += 1) {
                const measurement = await runSave(
                    session.page,
                    workingFixture,
                    `save benchmark ${mode} ${tier} ${String(index)}`,
                );
                const rssBytes = await readResidentBytes(
                    getSessionInfo(session.name)?.electronPid ?? null,
                );
                if (rssBytes !== null) {
                    peakRssBytes = Math.max(peakRssBytes ?? 0, rssBytes);
                }
                if (index >= warmups) {
                    timings.push(measurement.durationMs);
                    iterationMeasurements.push({
                        iteration: index - warmups + 1,
                        ...measurement,
                    });
                }
            }
            const outputBytes = await readFile(workingFixture);
            const semanticReopen = await readPdfAnnotationSummary(workingFixture);
            const result = {
                schemaVersion: 1,
                scenario: `${mode}-${tier}`,
                mode,
                tier,
                hostProfile,
                fixturePath,
                inputPath: fixturePath,
                outputPath: workingFixture,
                warmups,
                iterations,
                iterationMeasurements,
                totalMs: {
                    p50: percentile(timings, 0.5),
                    p95: percentile(timings, 0.95),
                    samples: timings,
                },
                peakRssBytes,
                ioBytes: {
                    logicalRead: null,
                    logicalWritten: null,
                    physicalRead: null,
                    physicalWritten: null,
                },
                phaseTimingsMs: {
                    baseHash: null,
                    cloneOrCopy: null,
                    conflictCheck: null,
                    expectationRefresh: null,
                    fileSync: null,
                    historyReload: null,
                    pdfJsSemanticReopen: null,
                    qpdf: null,
                    rustLoad: null,
                    rustReopen: null,
                    rustTail: null,
                    targetedValidation: null,
                },
                inputBytes,
                outputBytes: outputBytes.byteLength,
                outputSha256: createHash('sha256').update(outputBytes).digest('hex'),
                semanticReopen,
            };
            await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`);
        } finally {
            await session.stop();
        }
    }, 30 * 60_000);
});
