import {stat} from 'node:fs/promises';
import {dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {utilityProcess} from 'electron';
import {WORKER_BUNDLES_BY_ID} from '@electron-worker-bundles/electronWorkerBundles.js';
import {resolveUnpackedWorkerPath} from '@electron/utils/workerTask';
import {mainJobBroker} from '@electron/resources/jobBroker';
import {decodeDocumentSaveUtilityResult} from '@electron/features/documents/main/documentSaveUtilityProtocol';
import {abortErrorFromSignal} from '@electron/utils/abort';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ADMISSION_TIMEOUT_MS = 15_000;
const FINGERPRINT_TIMEOUT_MS = 2 * 60_000;

export async function runDocumentSaveUtilityProcess(options: {
    cwd: string;
    serviceName: string;
    utilityName: string;
    timeoutMs: number;
    request: unknown;
    signal?: AbortSignal;
}) {
    const workerPath = resolveUnpackedWorkerPath(
        __dirname,
        WORKER_BUNDLES_BY_ID['document-save-utility'].fileName,
    );
    return new Promise<{
        bytes: number;
        sha256: string;
    }>((resolve, reject) => {
        const child = utilityProcess.fork(workerPath, [], {
            cwd: options.cwd,
            serviceName: options.serviceName,
            stdio: 'ignore',
        });
        let settled = false;
        const finish = (error?: Error, result?: {
            bytes: number;
            sha256: string;
        }) => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timeout);
            options.signal?.removeEventListener('abort', abort);
            if (child.pid !== undefined) child.kill();
            if (error) reject(error); else resolve(result!);
        };
        const abort = () => finish(abortErrorFromSignal(options.signal!));
        const timeout = setTimeout(
            () => finish(new Error(`${options.utilityName} timed out`)),
            options.timeoutMs,
        );
        timeout.unref?.();
        options.signal?.addEventListener('abort', abort, {once: true});
        child.once('spawn', () => child.postMessage(options.request));
        child.once('message', (value) => {
            const result = decodeDocumentSaveUtilityResult(value);
            if (!result) {
                return finish(new Error(`${options.utilityName} returned an invalid result`));
            }
            if (!result.ok) {
                return finish(new Error(result.error));
            }
            finish(undefined, {
                bytes: result.bytes,
                sha256: result.sha256,
            });
        });
        child.once('error', (_type, location) => finish(new Error(`${options.utilityName} failed at ${location}`)));
        child.once('exit', code => {
            if (!settled) finish(new Error(`${options.utilityName} exited before completion (${code})`));
        });
    });
}

export async function fingerprintFileWithUtilityProcess(path: string) {
    const {size} = await stat(path);
    const lease = await mainJobBroker.acquire({
        ownerId: `document-fingerprint:${path}`,
        kind: 'document-save-utility',
        priority: 'user',
        resources: {
            cpuTokens: 1,
            estimatedResidentBytes: 256 * 1024 * 1024,
            nativeProcesses: 0,
            ioWeight: 4,
        },
        signal: AbortSignal.timeout(ADMISSION_TIMEOUT_MS),
    });
    try {
        return await runDocumentSaveUtilityProcess({
            cwd: dirname(path),
            serviceName: 'EVB document fingerprint',
            utilityName: 'Document fingerprint utility',
            timeoutMs: FINGERPRINT_TIMEOUT_MS,
            request: {
                type: 'inspect',
                sourcePath: path,
                expectedBytes: size,
            },
        });
    } finally {
        lease.release();
    }
}
