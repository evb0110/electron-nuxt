import { existsSync } from 'fs';
import { join } from 'path';
import { Worker } from 'worker_threads';
import { getErrorMessage } from '@electron/utils/error';

type TResultWorkerPayload<T> =
    | {
        type: 'result';
        ok: true;
        data?: T;
    }
    | {
        type: 'result';
        ok: false;
        error: string;
    };

interface IRunResultWorkerTaskOptions {
    workerPath: string;
    workerData: unknown;
    invalidPayloadMessage: string;
    createStartError?: ((message: string) => Error) | null;
    createStartupError?: (message: string) => Error;
    createStartupExitError?: (code: number) => Error;
    createWorkerExitError: (code: number) => Error;
}

export function resolveUnpackedWorkerPath(baseDir: string, workerFileName: string) {
    const defaultPath = join(baseDir, workerFileName);
    const unpackedPath = defaultPath.replace('app.asar', 'app.asar.unpacked');
    if (unpackedPath !== defaultPath && existsSync(unpackedPath)) {
        return unpackedPath;
    }
    return defaultPath;
}

function isResultWorkerPayload<T>(payload: unknown): payload is TResultWorkerPayload<T> {
    return typeof payload === 'object'
        && payload !== null
        && 'type' in payload
        && payload.type === 'result';
}

function toError(error: unknown) {
    return error instanceof Error ? error : new Error(String(error));
}

export async function runResultWorkerTask<T>({
    workerPath,
    workerData,
    invalidPayloadMessage,
    createStartError,
    createStartupError,
    createStartupExitError,
    createWorkerExitError,
}: IRunResultWorkerTaskOptions): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        let settled = false;
        let online = false;
        let worker: Worker;

        try {
            worker = new Worker(workerPath, { workerData });
        } catch (error) {
            const buildStartError = createStartError === null
                ? undefined
                : createStartError ?? createStartupError;
            reject(buildStartError ? buildStartError(getErrorMessage(error)) : toError(error));
            return;
        }

        const finalize = (callback: () => void) => {
            if (settled) {
                return;
            }
            settled = true;
            worker.removeAllListeners();
            void worker.terminate().catch(() => {});
            callback();
        };

        worker.once('online', () => {
            online = true;
        });

        worker.once('message', (payload: unknown) => {
            finalize(() => {
                if (!isResultWorkerPayload<T>(payload)) {
                    reject(new Error(invalidPayloadMessage));
                    return;
                }
                if (!payload.ok) {
                    reject(new Error(payload.error));
                    return;
                }
                resolve(payload.data as T);
            });
        });

        worker.once('error', (error) => {
            finalize(() => {
                if (!online && createStartupError) {
                    reject(createStartupError(getErrorMessage(error)));
                    return;
                }
                reject(toError(error));
            });
        });

        worker.once('exit', (code) => {
            if (settled || code === 0) {
                return;
            }
            finalize(() => {
                if (!online && createStartupExitError) {
                    reject(createStartupExitError(code));
                    return;
                }
                reject(createWorkerExitError(code));
            });
        });
    });
}
