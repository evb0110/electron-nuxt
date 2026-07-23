import {spawn} from 'child_process';
import {createInterface} from 'readline';
import type {TNativeErrorCode} from '@contracts/nativeErrors';
import type {
    INativeScanCleanupProgressV3,
    IScanCleanupProgress,
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

export async function runScanCleanupSidecar(
    binaryPath: string,
    manifestPath: string,
    signal: AbortSignal,
    log: TWorkerLog,
    onProgress: (progress: IScanCleanupProgress, nativeProgress: INativeScanCleanupProgressV3) => void,
) {
    if (signal.aborted) throw abortErrorFromSignal(signal);
    const child = spawn(binaryPath, [
        '--manifest',
        manifestPath,
    ], createDetachedChildProcessSpawnOptions({stdio: [
        'ignore',
        'pipe',
        'pipe',
    ]}));
    let stderr = '';
    let terminalResult: 'success' | 'failure' | null = null;
    let protocolError: Error | null = null;
    let nativeFailure: NativeScanCleanupError | null = null;
    const completedPageNumbers = new Set<number>();
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
        stderr = `${stderr}${chunk}`.slice(-64 * 1024);
    });
    const lines = createInterface({input: child.stdout!});
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
                onProgress({
                    stage: nativeProgress.stage === 'page-analyzed' ? 'detecting' : 'cleaning',
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
            protocolError = error instanceof Error ? error : new Error(String(error));
            log('warn', `Rejected malformed evb-scan-cleanup NDJSON: ${line.slice(0, 200)}`);
        }
    });
    let aborting = false;
    const handleAbort = () => {
        aborting = true;
        // AbortSignal is the transport boundary. This native adapter first asks
        // the detached process tree to exit, then force-kills after its grace period.
        void terminateDetachedChildProcess(child, 1_500);
    };
    signal.addEventListener('abort', handleAbort, {once: true});
    try {
        const result = await new Promise<{
            code: number | null;
            signal: NodeJS.Signals | null
        }>((resolve, reject) => {
            child.once('error', reject);
            child.once('exit', (code, exitSignal) => resolve({
                code,
                signal: exitSignal,
            }));
        });
        if (aborting || signal.aborted) throw abortErrorFromSignal(signal);
        throwIfError(protocolError);
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
    }
}
