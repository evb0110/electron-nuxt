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

interface IRunResultWorkerTaskOptions<T = unknown> {
    workerPath: string;
    workerData: unknown;
    invalidPayloadMessage: string;
    createStartError?: ((message: string) => Error) | null;
    createStartupError?: (message: string) => Error;
    createStartupExitError?: (code: number) => Error;
    createWorkerExitError: (code: number) => Error;
    onProgressMessage?: (payload: unknown) => boolean;
    decodeResult?: (data: unknown) => T | null;
    invalidResultMessage?: string;
    signal?: AbortSignal;
    timeoutMs?: number;
}

export interface IStreamingWorkerTaskHandle<T> {
    worker: Worker;
    promise: Promise<T>;
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

function getAbortReason(signal: AbortSignal) {
    if (signal.reason !== undefined) {
        return signal.reason;
    }
    return new DOMException('The operation was aborted', 'AbortError');
}

function settleWorkerAfterTask(worker: Worker) {
    const ignoreLateWorkerError = () => undefined;
    worker.removeAllListeners('message');
    worker.removeAllListeners('online');
    worker.removeAllListeners('exit');
    worker.removeAllListeners('error');
    worker.on('error', ignoreLateWorkerError);
    void worker.terminate().catch(() => undefined).finally(() => {
        worker.removeListener('error', ignoreLateWorkerError);
    });
}

interface IAttachWorkerHandlersOptions<T> {
    worker: Worker;
    options: IRunResultWorkerTaskOptions<T>;
    resolve: (value: T) => void;
    reject: (reason: unknown) => void;
}

function attachWorkerHandlers<T>({
    worker,
    options,
    resolve,
    reject,
}: IAttachWorkerHandlersOptions<T>) {
    const {
        invalidPayloadMessage,
        createStartupError,
        createStartupExitError,
        createWorkerExitError,
        onProgressMessage,
        decodeResult,
        invalidResultMessage,
    } = options;
    let settled = false;
    let online = false;
    let timeout: NodeJS.Timeout | null = null;

    const finalize = (callback: () => void) => {
        if (settled) {
            return;
        }
        settled = true;
        if (timeout) {
            clearTimeout(timeout);
            timeout = null;
        }
        options.signal?.removeEventListener('abort', handleAbort);
        settleWorkerAfterTask(worker);
        callback();
    };

    const handleAbort = () => {
        finalize(() => {
            reject(getAbortReason(options.signal!));
        });
    };

    if (options.signal?.aborted) {
        handleAbort();
        return;
    }
    options.signal?.addEventListener('abort', handleAbort, { once: true });

    if (options.timeoutMs !== undefined) {
        timeout = setTimeout(() => {
            finalize(() => {
                reject(new Error(`Worker task timed out after ${options.timeoutMs}ms`));
            });
        }, options.timeoutMs);
    }

    worker.once('online', () => {
        online = true;
    });

    const handleMessage = (payload: unknown) => {
        if (onProgressMessage?.(payload)) {
            return;
        }
        finalize(() => {
            if (!isResultWorkerPayload<T>(payload)) {
                reject(new Error(invalidPayloadMessage));
                return;
            }
            if (!payload.ok) {
                reject(new Error(payload.error));
                return;
            }
            if (decodeResult) {
                const decoded = decodeResult(payload.data);
                if (decoded === null) {
                    reject(new Error(invalidResultMessage ?? invalidPayloadMessage));
                    return;
                }
                resolve(decoded);
                return;
            }
            resolve(payload.data as T);
        });
    };

    if (onProgressMessage) {
        worker.on('message', handleMessage);
    } else {
        worker.once('message', handleMessage);
    }

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
        if (settled) {
            return;
        }
        finalize(() => {
            if (code === 0) {
                reject(new Error(invalidResultMessage ?? invalidPayloadMessage));
                return;
            }
            if (!online && createStartupExitError) {
                reject(createStartupExitError(code));
                return;
            }
            reject(createWorkerExitError(code));
        });
    });
}

export async function runResultWorkerTask<T>(options: IRunResultWorkerTaskOptions<T>): Promise<T> {
    const {
        workerPath,
        workerData,
        createStartError,
        createStartupError,
    } = options;
    return new Promise<T>((resolve, reject) => {
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
        attachWorkerHandlers<T>({
            worker,
            options,
            resolve,
            reject, 
        });
    });
}

export function startStreamingWorkerTask<T>(
    options: IRunResultWorkerTaskOptions<T> & { createStartupError: (message: string) => Error },
): IStreamingWorkerTaskHandle<T> {
    const {
        workerPath,
        workerData,
        createStartupError,
    } = options;
    if (!existsSync(workerPath)) {
        throw createStartupError(`Worker unavailable at path: ${workerPath}`);
    }
    const worker = new Worker(workerPath, { workerData });
    const promise = new Promise<T>((resolve, reject) => {
        attachWorkerHandlers<T>({
            worker,
            options,
            resolve,
            reject, 
        });
    });
    return {
        worker,
        promise, 
    };
}
