import { spawn } from 'child_process';
import { createInterface } from 'readline';
import type { TWorkerLog } from '@electron/ocr/worker/types';
import {
    createDetachedChildProcessSpawnOptions,
    terminateDetachedChildProcess,
} from '@electron/utils/nativeChildProcess';
import { abortErrorFromSignal } from '@electron/utils/abort';

export interface IScanCleanupSidecarProgress {
    event: string;
    page: number;
    total: number;
    outputPaths?: string[];
}

export async function runScanCleanupSidecar(
    binaryPath: string,
    manifestPath: string,
    signal: AbortSignal,
    log: TWorkerLog,
    onProgress: (progress: IScanCleanupSidecarProgress) => void,
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
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
        stderr = `${stderr}${chunk}`.slice(-64 * 1024);
    });
    const lines = createInterface({input: child.stdout!});
    lines.on('line', line => {
        try {
            const value = JSON.parse(line) as IScanCleanupSidecarProgress;
            if (typeof value.event === 'string' && Number.isFinite(value.page) && Number.isFinite(value.total)) {
                onProgress(value);
            }
        } catch {
            log('warn', `Ignored malformed evb-scan-cleanup progress line: ${line.slice(0, 200)}`);
        }
    });
    let aborting = false;
    const handleAbort = () => {
        aborting = true;
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
        if (result.code !== 0) {
            throw new Error(`evb-scan-cleanup failed (code=${String(result.code)}, signal=${String(result.signal)}): ${stderr.trim()}`);
        }
    } finally {
        signal.removeEventListener('abort', handleAbort);
        lines.close();
    }
}
