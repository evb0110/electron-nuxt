import type {
    IpcRenderer,
    IpcRendererEvent,
} from 'electron';
import type { TMenuEventUnsubscribe } from '@contracts/electronApiCommon';
import type { IIpcInvokeSpec } from '@contracts/ipcMain';
import { CORE_IPC_SEND_CHANNELS } from '@electron/platform-ipc/coreContract';

type TNoArgEventChannel<TEventMap extends {[TChannel in keyof TEventMap]: unknown}> = Extract<{
    [TChannel in keyof TEventMap]: TEventMap[TChannel] extends undefined ? TChannel : never;
}[keyof TEventMap], string>;

type TPayloadEventChannel<TEventMap extends {[TChannel in keyof TEventMap]: unknown}> = Exclude<
    Extract<keyof TEventMap, string>,
    TNoArgEventChannel<TEventMap>
>;

type TIpcResultDecoder<TResult> = (value: unknown) => TResult | null;
type TIpcPayloadDecoder<TPayload> = (value: unknown) => TPayload | null;
type TIpcInvokeTimeoutMap<TChannel extends string = string> = Readonly<Partial<Record<TChannel, number>>>;

interface IIpcInvokerOptions<TChannel extends string = string> { invokeTimeoutMsByChannel?: TIpcInvokeTimeoutMap<TChannel>; }

function logDecodedEventValidationFailure(
    ipcRenderer: Pick<IpcRenderer, 'send'>,
    channel: string,
    payload: unknown,
) {
    const message = `Dropped invalid decoded IPC event payload for ${channel}`;
    if (process.env.NODE_ENV !== 'production') {
        console.warn(message, payload);
    }
    try {
        ipcRenderer.send(CORE_IPC_SEND_CHANNELS.rendererLog, {
            level: 'warn',
            section: 'ipc-client',
            message,
            timestamp: new Date().toISOString(),
            data: { channel },
        });
    } catch {
        // Ignore logging failures in preload.
    }
}

class IpcInvokeTimeoutError extends Error {
    readonly channel: string;
    readonly timeoutMs: number;

    constructor(channel: string, timeoutMs: number) {
        super(`IPC invoke timed out after ${timeoutMs}ms for ${channel}`);
        this.name = 'IpcInvokeTimeoutError';
        this.channel = channel;
        this.timeoutMs = timeoutMs;
    }
}

class PlatformIpcInvokeError extends Error {
    readonly channel: string;
    override readonly cause: unknown;

    constructor(channel: string, cause: unknown) {
        const message = cause instanceof Error && cause.message
            ? cause.message
            : `IPC invoke failed for ${channel}`;
        super(message);
        this.name = 'PlatformIpcInvokeError';
        this.channel = channel;
        this.cause = cause;
    }
}

async function invokeWithChannelContext<TResult>(
    ipcRenderer: Pick<IpcRenderer, 'invoke'>,
    channel: string,
    args: unknown[],
    options?: IIpcInvokerOptions,
) {
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    try {
        const invokePromise = ipcRenderer.invoke(channel, ...args) as Promise<TResult>;
        const timeoutMs = options?.invokeTimeoutMsByChannel?.[channel];
        if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
            return await invokePromise;
        }

        return await Promise.race([
            invokePromise,
            new Promise<never>((_resolve, reject) => {
                timeoutHandle = setTimeout(() => {
                    reject(new IpcInvokeTimeoutError(channel, timeoutMs));
                }, timeoutMs);
                timeoutHandle.unref?.();
            }),
        ]);
    } catch (error) {
        throw new PlatformIpcInvokeError(channel, error);
    } finally {
        if (timeoutHandle) {
            clearTimeout(timeoutHandle);
        }
    }
}

export function createTypedIpcInvoker<TMap extends {[TChannel in keyof TMap]: IIpcInvokeSpec}>(
    ipcRenderer: Pick<IpcRenderer, 'invoke'>,
    options?: IIpcInvokerOptions<Extract<keyof TMap, string>>,
) {
    return function invoke<TChannel extends Extract<keyof TMap, string>>(
        channel: TChannel,
        ...args: TMap[TChannel]['args']
    ) {
        return invokeWithChannelContext<TMap[TChannel]['result']>(ipcRenderer, channel, args, options);
    };
}

export function createDecodedIpcInvoker<TMap extends {[TChannel in keyof TMap]: IIpcInvokeSpec}>(
    ipcRenderer: Pick<IpcRenderer, 'invoke'>,
    options?: IIpcInvokerOptions<Extract<keyof TMap, string>>,
) {
    return async function invokeDecoded<TChannel extends Extract<keyof TMap, string>>(
        channel: TChannel,
        decode: TIpcResultDecoder<TMap[TChannel]['result']>,
        ...args: TMap[TChannel]['args']
    ) {
        const result: unknown = await invokeWithChannelContext<unknown>(ipcRenderer, channel, args, options);
        const decoded = decode(result);
        if (decoded === null) {
            throw new PlatformIpcInvokeError(channel, new Error(`Invalid IPC response for ${channel}`));
        }
        return decoded;
    };
}

export function createTypedIpcEventSubscriber<
    TEventMap extends {[TChannel in keyof TEventMap]: unknown},
>(ipcRenderer: IpcRenderer) {
    return {
        onNoArg<TChannel extends TNoArgEventChannel<TEventMap>>(
            channel: TChannel,
            callback: () => void,
        ): TMenuEventUnsubscribe {
            const handler = (_event: IpcRendererEvent) => callback();
            ipcRenderer.on(channel, handler);
            return () => ipcRenderer.removeListener(channel, handler);
        },

        onPayload<TChannel extends TPayloadEventChannel<TEventMap>>(
            channel: TChannel,
            callback: (payload: TEventMap[TChannel]) => void,
        ): TMenuEventUnsubscribe {
            const handler = (_event: IpcRendererEvent, payload: TEventMap[TChannel]) => callback(payload);
            ipcRenderer.on(channel, handler);
            return () => ipcRenderer.removeListener(channel, handler);
        },

        onDecodedPayload<TChannel extends TPayloadEventChannel<TEventMap>>(
            channel: TChannel,
            decode: TIpcPayloadDecoder<TEventMap[TChannel]>,
            callback: (payload: TEventMap[TChannel]) => void,
        ): TMenuEventUnsubscribe {
            const handler = (_event: IpcRendererEvent, payload: unknown) => {
                const decoded = decode(payload);
                if (decoded !== null) {
                    callback(decoded);
                    return;
                }
                logDecodedEventValidationFailure(ipcRenderer, channel, payload);
            };
            ipcRenderer.on(channel, handler);
            return () => ipcRenderer.removeListener(channel, handler);
        },
    };
}
