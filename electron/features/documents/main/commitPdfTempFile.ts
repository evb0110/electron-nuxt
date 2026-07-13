import { stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { utilityProcess } from 'electron';
import { WORKER_BUNDLES_BY_ID } from '@electron-worker-bundles/electronWorkerBundles.js';
import { resolveUnpackedWorkerPath } from '@electron/utils/workerTask';
import { abortErrorFromSignal } from '@electron/utils/abort';
import { markActiveWorkingCopyMutationCommitStarted } from '@electron/file-access/workingCopyMutationCommitSignal';
import { mainJobBroker } from '@electron/resources/jobBroker';
import type { IJobBrokerLease } from '@electron/resources/jobBroker';
import { decodeDocumentSaveUtilityResult } from '@electron/features/documents/main/documentSaveUtilityProtocol';
import { documentOutputService } from '@electron/output/documentOutputService';
import { getPdfNativeToolPaths } from '@electron/pdf/nativeToolPaths';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_THRESHOLD = 64 * 1024 * 1024;
const SAVE_UTILITY_THRESHOLD = (() => {
    const value = Number.parseInt(process.env.EVB_DOCUMENT_SAVE_UTILITY_THRESHOLD_BYTES ?? `${DEFAULT_THRESHOLD}`, 10);
    return Number.isSafeInteger(value) && value > 0 ? value : DEFAULT_THRESHOLD;
})();

function shouldUseDocumentSaveUtility(bytes: number) {
    return bytes >= SAVE_UTILITY_THRESHOLD;
}

export async function commitPdfTempFile(sourcePath: string, targetPath: string, options: {
    expectedBytes?: number;
    signal?: AbortSignal;
    ownerId?: string;
    changedObjectRefs?: string[];
} = {}) {
    const outputJob = documentOutputService.start({
        operation: 'save-as-pdf',
        sourceKind: 'pdf',
        initialPhase: 'validating',
    });
    const signal = options.signal
        ? AbortSignal.any([
            options.signal,
            outputJob.signal,
        ])
        : outputJob.signal;
    let lease: IJobBrokerLease | undefined;
    try {
        const expectedBytes = options.expectedBytes ?? (await stat(sourcePath)).size;
        if (!shouldUseDocumentSaveUtility(expectedBytes) && !options.changedObjectRefs?.length) {
            const {atomicReplace} = await import('@electron/utils/atomicReplace');
            await atomicReplace(sourcePath, targetPath);
            documentOutputService.handoff(outputJob.jobId, targetPath, {
                phase: 'publishing',
                percent: 100,
            });
            documentOutputService.finish(outputJob.jobId, 'completed');
            return null;
        }
        lease = await mainJobBroker.acquire({
            ownerId: options.ownerId ?? `document-save:${targetPath}`,
            kind: 'document-save-utility',
            priority: 'user',
            resources: {
                cpuTokens: 1,
                estimatedResidentBytes: 256 * 1024 * 1024,
                nativeProcesses: 1,
                ioWeight: 4,
            },
            signal,
        });
        markActiveWorkingCopyMutationCommitStarted();
        const workerPath = resolveUnpackedWorkerPath(
            __dirname,
            WORKER_BUNDLES_BY_ID['document-save-utility'].fileName,
        );
        const result = await new Promise<{
            bytes: number;
            sha256: string
        }>((resolve, reject) => {
            const child = utilityProcess.fork(workerPath, [], {
                cwd: dirname(sourcePath),
                serviceName: 'EVB document save',
                stdio: 'ignore',
            });
            let settled = false;
            const finish = (error?: Error, result?: {
                bytes: number;
                sha256: string
            }) => {
                if (settled) {
                    return;
                }
                settled = true;
                clearTimeout(timeout);
                signal.removeEventListener('abort', abort);
                if (child.pid !== undefined) child.kill();
                if (error) reject(error); else resolve(result!);
            };
            const abort = () => finish(abortErrorFromSignal(signal));
            const timeout = setTimeout(() => finish(new Error('Document save utility timed out')), 10 * 60_000);
            timeout.unref?.();
            signal.addEventListener('abort', abort, {once: true});
            child.once('spawn', () => child.postMessage({
                type: 'commit',
                sourcePath,
                targetPath,
                expectedBytes,
                validationBinary: getPdfNativeToolPaths().qpdf,
                ...(options.changedObjectRefs?.length ? {changedObjectRefs: options.changedObjectRefs} : {}),
            }));
            child.once('message', (value) => {
                const result = decodeDocumentSaveUtilityResult(value);
                if (!result) {
                    return finish(new Error('Document save utility returned an invalid result'));
                }
                if (!result.ok) {
                    return finish(new Error(result.error));
                }
                finish(undefined, {
                    bytes: result.bytes,
                    sha256: result.sha256,
                });
            });
            child.once('error', (_type, location) => finish(new Error(`Document save utility failed at ${location}`)));
            child.once('exit', code => {
                if (!settled) finish(new Error(`Document save utility exited before completion (${code})`));
            });
        });
        documentOutputService.handoff(outputJob.jobId, targetPath, {
            phase: 'publishing',
            percent: 100,
        });
        documentOutputService.finish(outputJob.jobId, 'completed');
        return result;
    } catch (error) {
        documentOutputService.finish(
            outputJob.jobId,
            signal.aborted ? 'canceled' : 'failed',
            error instanceof Error ? error.message : String(error),
        );
        throw error;
    } finally {
        lease?.release();
    }
}
