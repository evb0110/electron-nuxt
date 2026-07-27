import { existsSync } from 'fs';
import { join } from 'path';
import {
    Worker,
    type ResourceLimits,
} from 'worker_threads';
import { isRecord } from '@contracts/runtimeGuards';
import { isAbortError } from '@electron/utils/abort';
import { getErrorMessage } from '@electron/utils/error';
import { createLogger } from '@electron/utils/createLogger';

const workerTaskLog = createLogger('worker-task');

export interface IWorkerTaskErrorFrame {
    message: string;
    name?: string;
    code?: string;
    canceled?: boolean;
    retryable?: boolean;
    source?: string;
}

type TResultWorkerPayload =
    | {
        type: 'result';
        ok: true;
        data?: unknown;
    }
    | {
        type: 'result';
        ok: false;
        error: string;
        errorFrame?: IWorkerTaskErrorFrame;
    };

type TResultWorkerDecoder<T> = (data: unknown) => T | null;

interface IRunResultWorkerTaskBaseOptions {
    workerPath: string;
    workerData: unknown;
    invalidPayloadMessage: string;
    createStartError?: ((message: string) => Error) | null;
    createStartupError?: (message: string) => Error;
    createStartupExitError?: (code: number) => Error;
    createWorkerExitError: (code: number) => Error;
    onProgressMessage?: (payload: unknown) => boolean;
    invalidResultMessage?: string;
    signal?: AbortSignal;
    timeoutMs?: number;
    createCancelMessage?: (reason: 'abort' | 'timeout') => unknown;
    cooperativeCancelDelayMs?: number;
    resourceLimits?: ResourceLimits;
}

interface IDecodedResultWorkerTaskOptions<T> extends IRunResultWorkerTaskBaseOptions {decodeResult: TResultWorkerDecoder<T>;}

interface IUnknownResultWorkerTaskOptions extends IRunResultWorkerTaskBaseOptions {decodeResult?: undefined;}

type TRunResultWorkerTaskOptions<T = unknown> =
    | IDecodedResultWorkerTaskOptions<T>
    | IUnknownResultWorkerTaskOptions;

export interface IStreamingWorkerTaskHandle<T> {
    worker: Worker;
    promise: Promise<T>;
}

export class WorkerTaskError extends Error {
    readonly code: string | undefined;
    readonly canceled: boolean;
    readonly retryable: boolean;
    readonly source: string | undefined;

    constructor(frame: IWorkerTaskErrorFrame) {
        super(frame.message);
        this.name = frame.name ?? 'WorkerTaskError';
        this.code = frame.code;
        this.canceled = frame.canceled ?? false;
        this.retryable = frame.retryable ?? false;
        this.source = frame.source;
    }
}

function getErrorStringProperty(error: unknown, key: 'name' | 'code') {
    if (!error || typeof error !== 'object') {
        return undefined;
    }
    const value = (error as Record<string, unknown>)[key];
    return typeof value === 'string' && value.length > 0
        ? value
        : undefined;
}

export function createWorkerTaskErrorFrame(
    error: unknown,
    options: {
        source?: string;
        retryable?: boolean;
    } = {},
): IWorkerTaskErrorFrame {
    const frame: IWorkerTaskErrorFrame = {
        message: getErrorMessage(error),
        canceled: isAbortError(error),
        retryable: options.retryable ?? false,
    };
    const name = getErrorStringProperty(error, 'name');
    if (name !== undefined) {
        frame.name = name;
    }
    const code = getErrorStringProperty(error, 'code');
    if (code !== undefined) {
        frame.code = code;
    } else if (frame.canceled) {
        frame.code = 'ABORT_ERR';
    }
    if (options.source) {
        frame.source = options.source;
    }
    return frame;
}

export function resolveUnpackedWorkerPath(baseDir: string, workerFileName: string) {
    const defaultPath = join(baseDir, workerFileName);
    const unpackedPath = defaultPath.replace('app.asar', 'app.asar.unpacked');
    if (unpackedPath !== defaultPath && existsSync(unpackedPath)) {
        return unpackedPath;
    }
    return defaultPath;
}

function parseWorkerTaskErrorFrame(value: unknown): IWorkerTaskErrorFrame | null {
    if (!isRecord(value) || typeof value.message !== 'string') {
        return null;
    }
    if (value.name !== undefined && typeof value.name !== 'string') {
        return null;
    }
    if (value.code !== undefined && typeof value.code !== 'string') {
        return null;
    }
    if (value.canceled !== undefined && typeof value.canceled !== 'boolean') {
        return null;
    }
    if (value.retryable !== undefined && typeof value.retryable !== 'boolean') {
        return null;
    }
    if (value.source !== undefined && typeof value.source !== 'string') {
        return null;
    }
    return {
        message: value.message,
        ...(value.name === undefined ? {} : {name: value.name}),
        ...(value.code === undefined ? {} : {code: value.code}),
        ...(value.canceled === undefined ? {} : {canceled: value.canceled}),
        ...(value.retryable === undefined ? {} : {retryable: value.retryable}),
        ...(value.source === undefined ? {} : {source: value.source}),
    };
}

function parseResultWorkerPayload(payload: unknown): TResultWorkerPayload | null {
    if (!isRecord(payload) || payload.type !== 'result') {
        return null;
    }

    if (payload.ok === true) {
        return {
            type: 'result',
            ok: true,
            ...('data' in payload ? {data: payload.data} : {}),
        };
    }

    if (payload.ok === false) {
        const errorFrame = parseWorkerTaskErrorFrame(payload.errorFrame);
        if (typeof payload.error !== 'string' && errorFrame === null) {
            return null;
        }
        return {
            type: 'result',
            ok: false,
            error: typeof payload.error === 'string' ? payload.error : errorFrame?.message ?? 'Worker task failed',
            ...(errorFrame === null ? {} : {errorFrame}),
        };
    }

    return null;
}

function toError(error: unknown) {
    return error instanceof Error ? error : new Error(String(error));
}

function createWorkerTaskError(payload: Extract<TResultWorkerPayload, {ok: false;}>) {
    return new WorkerTaskError(payload.errorFrame ?? {
        message: payload.error,
        canceled: false,
        retryable: false,
    });
}

function getAbortReason(signal: AbortSignal) {
    if (signal.reason !== undefined) {
        const reason: unknown = signal.reason;
        return reason;
    }
    return new DOMException('The operation was aborted', 'AbortError');
}

function createWorkerOptions(workerData: unknown, resourceLimits: ResourceLimits | undefined) {
    const workerOptions: {
        workerData: unknown;
        resourceLimits?: ResourceLimits;
    } = { workerData };
    if (resourceLimits) {
        workerOptions.resourceLimits = resourceLimits;
    }
    return workerOptions;
}

function terminateWorkerAfterTask(worker: Worker) {
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

function postWorkerCancelMessage(worker: Worker, message: unknown) {
    try {
        worker.postMessage(message);
    } catch {
        // Worker may already be exiting.
    }
}

interface IAttachWorkerHandlersOptions<T> {
    worker: Worker;
    options: TRunResultWorkerTaskOptions<T>;
    resolve: (value: T) => void;
    reject: (reason: unknown) => void;
    startedAt: number;
}

function attachWorkerHandlers<T>({
    worker,
    options,
    resolve,
    reject,
    startedAt,
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
    let cooperativeCancelTimer: NodeJS.Timeout | null = null;
    let hasPendingCancelError = false;
    let pendingCancelError: unknown;
    let firstMessageObserved = false;

    const cleanup = () => {
        if (timeout) {
            clearTimeout(timeout);
            timeout = null;
        }
        if (cooperativeCancelTimer) {
            clearTimeout(cooperativeCancelTimer);
            cooperativeCancelTimer = null;
        }
        options.signal?.removeEventListener('abort', handleAbort);
    };

    const finalize = (callback: () => void) => {
        if (settled) {
            return;
        }
        settled = true;
        cleanup();
        terminateWorkerAfterTask(worker);
        callback();
    };

    const requestCancel = (reason: 'abort' | 'timeout', error: unknown) => {
        if (settled || hasPendingCancelError) {
            return;
        }
        const cancelMessage = options.createCancelMessage?.(reason);
        if (cancelMessage === undefined) {
            finalize(() => {
                reject(error);
            });
            return;
        }

        pendingCancelError = error;
        hasPendingCancelError = true;
        cleanup();
        postWorkerCancelMessage(worker, cancelMessage);
        cooperativeCancelTimer = setTimeout(() => {
            finalize(() => {
                reject(error);
            });
        }, options.cooperativeCancelDelayMs ?? 1_000);
        cooperativeCancelTimer.unref?.();
    };

    const handleAbort = () => {
        requestCancel('abort', getAbortReason(options.signal!));
    };

    options.signal?.addEventListener('abort', handleAbort, { once: true });

    if (options.timeoutMs !== undefined) {
        timeout = setTimeout(() => {
            requestCancel('timeout', new Error(`Worker task timed out after ${options.timeoutMs}ms`));
        }, options.timeoutMs);
    }

    worker.once('online', () => {
        online = true;
        workerTaskLog.debug(
            `Worker online: path=${options.workerPath} onlineMs=${Math.round(performance.now() - startedAt)}`,
        );
    });

    const handleMessage = (payload: unknown) => {
        if (!firstMessageObserved) {
            firstMessageObserved = true;
            workerTaskLog.debug(
                `Worker first message: path=${options.workerPath} firstMessageMs=${Math.round(performance.now() - startedAt)}`,
            );
        }
        if (onProgressMessage?.(payload)) {
            return;
        }
        finalize(() => {
            if (hasPendingCancelError) {
                reject(pendingCancelError);
                return;
            }
            const resultPayload = parseResultWorkerPayload(payload);
            if (!resultPayload) {
                reject(new Error(invalidPayloadMessage));
                return;
            }
            if (!resultPayload.ok) {
                reject(createWorkerTaskError(resultPayload));
                return;
            }
            if (decodeResult) {
                const decoded = decodeResult(resultPayload.data);
                if (decoded === null) {
                    reject(new Error(invalidResultMessage ?? invalidPayloadMessage));
                    return;
                }
                resolve(decoded);
                return;
            }
            resolve(resultPayload.data as T);
        });
    };

    if (onProgressMessage) {
        worker.on('message', handleMessage);
    } else {
        worker.once('message', handleMessage);
    }

    worker.once('error', (error) => {
        finalize(() => {
            if (hasPendingCancelError) {
                reject(pendingCancelError);
                return;
            }
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
            if (hasPendingCancelError) {
                reject(pendingCancelError);
                return;
            }
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

    if (options.signal?.aborted) {
        handleAbort();
    }
}

export function runResultWorkerTask<T>(options: IDecodedResultWorkerTaskOptions<T>): Promise<T>;
export function runResultWorkerTask(options: IUnknownResultWorkerTaskOptions): Promise<unknown>;
export async function runResultWorkerTask<T>(
    options: TRunResultWorkerTaskOptions<T>,
): Promise<T | unknown> {
    const {
        workerPath,
        workerData,
        createStartError,
        createStartupError,
    } = options;
    if (options.signal?.aborted) {
        throw getAbortReason(options.signal);
    }
    return new Promise<T | unknown>((resolve, reject) => {
        let worker: Worker;
        const startedAt = performance.now();
        try {
            worker = new Worker(workerPath, createWorkerOptions(workerData, options.resourceLimits));
        } catch (error) {
            const buildStartError = createStartError === null
                ? undefined
                : createStartError ?? createStartupError;
            reject(buildStartError ? buildStartError(getErrorMessage(error)) : toError(error));
            return;
        }
        attachWorkerHandlers<T | unknown>({
            worker,
            options,
            resolve,
            reject,
            startedAt,
        });
    });
}

export function startStreamingWorkerTask<T>(
    options: IDecodedResultWorkerTaskOptions<T> & { createStartupError: (message: string) => Error },
): IStreamingWorkerTaskHandle<T>;
export function startStreamingWorkerTask(
    options: IUnknownResultWorkerTaskOptions & { createStartupError: (message: string) => Error },
): IStreamingWorkerTaskHandle<unknown>;
export function startStreamingWorkerTask<T>(
    options: TRunResultWorkerTaskOptions<T> & { createStartupError: (message: string) => Error },
): IStreamingWorkerTaskHandle<T | unknown> {
    const {
        workerPath,
        workerData,
        createStartupError,
    } = options;
    if (options.signal?.aborted) {
        throw getAbortReason(options.signal);
    }
    if (!existsSync(workerPath)) {
        throw createStartupError(`Worker unavailable at path: ${workerPath}`);
    }
    let worker: Worker;
    const startedAt = performance.now();
    try {
        worker = new Worker(workerPath, createWorkerOptions(workerData, options.resourceLimits));
    } catch (error) {
        throw createStartupError(getErrorMessage(error));
    }
    const promise = new Promise<T | unknown>((resolve, reject) => {
        attachWorkerHandlers<T | unknown>({
            worker,
            options,
            resolve,
            reject,
            startedAt,
        });
    });
    return {
        worker,
        promise,
    };
}
