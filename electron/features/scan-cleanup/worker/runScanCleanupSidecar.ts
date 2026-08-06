import {spawn} from 'child_process';
import {constants as fsConstants} from 'fs';
import {
    access,
    stat,
} from 'fs/promises';
import {basename} from 'path';
import {createInterface} from 'readline';
import {
    constants as osConstants,
    setPriority,
} from 'os';
import type {TNativeErrorCode} from '@contracts/nativeErrors';
import type {
    TNativeScanCleanupPageStageTimingsV3,
    TNativeScanCleanupProgressV3,
    TScanCleanupProgress,
} from '@contracts/electronApiScanCleanup';
import type {TWorkerLog} from '@electron/ocr/worker/types';
import {
    createDetachedChildProcessSpawnOptions,
    terminateDetachedChildProcess,
} from '@electron/utils/nativeChildProcess';
import {abortErrorFromSignal} from '@electron/utils/abort';
import {
    decodeNativeScanCleanupEnvelope,
    parseNativeScanCleanupStderr,
} from '@electron/features/scan-cleanup/native/protocolCodec';
import {verifyNativeToolProtocol} from '@electron/native-tools/runNativeToolCommand';
import {acquireNativeCommandAdmission} from '@electron/native-tools/runNativeCommand';

export class NativeScanCleanupError extends Error {
    constructor(readonly code: TNativeErrorCode, message: string) {
        super(message);
        this.name = 'NativeScanCleanupError';
    }
}

function throwIfError(error: Error | null) {
    if (error !== null) {
        throw error;
    }
}

type TScanCleanupStageTotalsMs = Record<
    'decode' | 'analysisLevel' | 'normalization' | 'split' | 'deskew' | 'content' | 'render' | 'write',
    number
>;

function addStageTimings(totals: TScanCleanupStageTotalsMs, timings: TNativeScanCleanupPageStageTimingsV3) {
    totals.decode += timings.decodeMs ?? 0;
    totals.analysisLevel += timings.analysisLevelMs ?? 0;
    totals.normalization += timings.normalizationMs ?? 0;
    totals.split += timings.splitMs ?? 0;
    totals.deskew += timings.deskewMs ?? 0;
    totals.content += timings.contentMs ?? 0;
    totals.render += timings.renderMs ?? 0;
    totals.write += timings.writeMs ?? 0;
}

function formatSeconds(milliseconds: number) {
    return `${(milliseconds / 1_000).toFixed(3)}s`;
}

function describeStageTotals(totals: TScanCleanupStageTotalsMs) {
    return Object.entries(totals)
        .filter(([
            ,
            milliseconds,
        ]) => milliseconds > 0)
        .map(([
            stage,
            milliseconds,
        ]) => `${stage}=${formatSeconds(milliseconds)}`);
}

export async function runScanCleanupSidecar(
    binaryPath: string,
    manifestPath: string,
    signal: AbortSignal,
    log: TWorkerLog,
    onProgress: (progress: TScanCleanupProgress, nativeProgress: TNativeScanCleanupProgressV3) => void,
    options: {priority?: 'background'} = {},
) {
    if (signal.aborted) throw abortErrorFromSignal(signal);
    await verifyNativeToolProtocol(binaryPath, {
        signal,
        log,
    });
    // The sidecar fans out over Rayon, so it is admitted through the same gate
    // as pdftoppm and qpdf instead of spawning beside them unaccounted.
    const releaseAdmission = await acquireNativeCommandAdmission(signal);
    try {
        await streamScanCleanupSidecar(
            binaryPath,
            manifestPath,
            signal,
            log,
            onProgress,
            options,
        );
    } finally {
        releaseAdmission();
    }
}

async function streamScanCleanupSidecar(
    binaryPath: string,
    manifestPath: string,
    signal: AbortSignal,
    log: TWorkerLog,
    onProgress: (progress: TScanCleanupProgress, nativeProgress: TNativeScanCleanupProgressV3) => void,
    options: {priority?: 'background'},
) {
    const child = spawn(binaryPath, [
        '--manifest',
        manifestPath,
    ], createDetachedChildProcessSpawnOptions({stdio: [
        'ignore',
        'pipe',
        'pipe',
    ]}));
    if (options.priority === 'background' && child.pid !== undefined) {
        try {
            setPriority(child.pid, osConstants.priority.PRIORITY_BELOW_NORMAL);
        } catch (error) {
            // Priority is an optimisation, not a correctness boundary. Some
            // sandboxed and hardened runtimes reject it; admission control and
            // cancellation still keep the process bounded there.
            log('debug', `Could not lower scan cleanup detection priority: ${String(error)}`);
        }
    }
    const startedAt = performance.now();
    let stderr = '';
    let terminalResult: 'success' | 'failure' | null = null;
    let protocolError: Error | null = null;
    let nativeFailure: NativeScanCleanupError | null = null;
    let terminationStarted = false;
    let timedPages = 0;
    const stageTotalsMs: TScanCleanupStageTotalsMs = {
        decode: 0,
        analysisLevel: 0,
        normalization: 0,
        split: 0,
        deskew: 0,
        content: 0,
        render: 0,
        write: 0,
    };
    const completedPageNumbers = new Set<number>();
    const terminateForFatalError = () => {
        if (terminationStarted) {
            return;
        }
        terminationStarted = true;
        void terminateDetachedChildProcess(child, 1_500);
    };
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
        stderr = `${stderr}${chunk}`.slice(-64 * 1024);
    });
    const lines = createInterface({input: child.stdout!});
    const failProtocol = (error: unknown, line: string) => {
        if (protocolError !== null) {
            return;
        }
        protocolError = error instanceof Error ? error : new Error(String(error));
        try {
            lines.close();
        } catch {
            // Termination and the original protocol failure still take precedence.
        }
        // A fatal decoder/schema/progress-consumer failure means stdout can no
        // longer be consumed safely. Stop the whole detached tree immediately;
        // the recorded protocol error remains the terminal authority.
        terminateForFatalError();
        log('warn', `Rejected malformed evb-scan-cleanup NDJSON: ${line.slice(0, 200)}`);
    };
    lines.on('line', line => {
        if (protocolError || terminalResult) {
            return;
        }
        try {
            const envelope = decodeNativeScanCleanupEnvelope(line);
            if (envelope.type === 'progress') {
                const nativeProgress = envelope.progress;
                if (
                    (nativeProgress.stage === 'page-analyzed' || nativeProgress.stage === 'page-complete')
                    && nativeProgress.pageNumber !== undefined
                ) {
                    completedPageNumbers.add(nativeProgress.pageNumber);
                }
                if (nativeProgress.stageTimings !== undefined) {
                    addStageTimings(stageTotalsMs, nativeProgress.stageTimings);
                    timedPages += 1;
                }
                onProgress({
                    stage: nativeProgress.stage === 'page-analyzed' ? 'classifying' : 'rendering',
                    completedUnits: nativeProgress.completedPages,
                    totalUnits: nativeProgress.totalPages,
                    percent: nativeProgress.totalPages === 0
                        ? 100
                        : nativeProgress.completedPages / nativeProgress.totalPages * 100,
                    completedPageNumbers: [...completedPageNumbers],
                }, nativeProgress);
                return;
            }
            terminalResult = envelope.result.status;
            if (envelope.result.status === 'failure') {
                nativeFailure = new NativeScanCleanupError(envelope.result.code, envelope.result.message);
            }
        } catch (error) {
            failProtocol(error, line);
        }
    });
    let aborting = false;
    const handleAbort = () => {
        aborting = true;
        // AbortSignal is the transport boundary. This native adapter first asks
        // the detached process tree to exit, then force-kills after its grace period.
        terminateForFatalError();
    };
    signal.addEventListener('abort', handleAbort, {once: true});
    if (signal.aborted) handleAbort();
    try {
        let result: {
            code: number | null;
            signal: NodeJS.Signals | null
        };
        try {
            result = await new Promise((resolve, reject) => {
                child.once('error', reject);
                child.once('exit', (code, exitSignal) => resolve({
                    code,
                    signal: exitSignal,
                }));
            });
        } catch (error) {
            throwIfError(protocolError);
            throw error;
        }
        throwIfError(protocolError);
        if (aborting || signal.aborted) throw abortErrorFromSignal(signal);
        throwIfError(nativeFailure);
        if (result.code !== 0) {
            const envelope = parseNativeScanCleanupStderr(stderr);
            if (envelope) throw new NativeScanCleanupError(envelope.code, envelope.message);
            throw new NativeScanCleanupError(
                'native-failure',
                `evb-scan-cleanup exited unsuccessfully (code=${String(result.code)}, signal=${String(result.signal)})`,
            );
        }
        if (terminalResult !== 'success') {
            throw new NativeScanCleanupError('native-failure', 'evb-scan-cleanup returned no terminal result envelope');
        }
    } finally {
        signal.removeEventListener('abort', handleAbort);
        lines.close();
        log('debug', [
            `evb-scan-cleanup timings ${basename(manifestPath)}:`,
            `wall=${formatSeconds(performance.now() - startedAt)}`,
            `timedPages=${timedPages}`,
            ...describeStageTotals(stageTotalsMs),
        ].join(' '));
    }
}

// The sidecar publishes exactly one raster per output and records which one in
// its metadata, so a declared payload that is missing here is a broken run
// rather than a case to degrade around.
export async function requirePublishedRaster(path: string | undefined, pageNumber: number, role: string) {
    if (path === undefined) {
        throw new Error(`Page ${pageNumber} declared a ${role} without an output destination`);
    }
    const stats = await stat(path).catch((error: NodeJS.ErrnoException) => {
        throw new Error(`Page ${pageNumber} ${role} is unavailable: ${error.message}`);
    });
    if (!stats.isFile()) {
        throw new Error(`Page ${pageNumber} ${role} is not a file: ${path}`);
    }
    await access(path, fsConstants.R_OK).catch((error: NodeJS.ErrnoException) => {
        throw new Error(`Page ${pageNumber} ${role} is unreadable: ${error.message}`);
    });
    return path;
}
