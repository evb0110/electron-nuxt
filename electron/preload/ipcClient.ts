import type {
    IpcRenderer,
    IpcRendererEvent,
} from 'electron';
import type { TMenuEventUnsubscribe } from '@contracts/electronApiCommon';
import type { IIpcInvokeSpec } from '@contracts/ipcMain';

type TNoArgEventChannel<TEventMap extends {[TChannel in keyof TEventMap]: unknown}> = Extract<{
    [TChannel in keyof TEventMap]: TEventMap[TChannel] extends undefined ? TChannel : never;
}[keyof TEventMap], string>;

type TPayloadEventChannel<TEventMap extends {[TChannel in keyof TEventMap]: unknown}> = Exclude<
    Extract<keyof TEventMap, string>,
    TNoArgEventChannel<TEventMap>
>;

type TIpcResultDecoder<TResult> = (value: unknown) => TResult | null;
type TIpcPayloadDecoder<TPayload> = (value: unknown) => TPayload | null;

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
) {
    try {
        return await ipcRenderer.invoke(channel, ...args) as TResult;
    } catch (error) {
        throw new PlatformIpcInvokeError(channel, error);
    }
}

export function createTypedIpcInvoker<TMap extends {[TChannel in keyof TMap]: IIpcInvokeSpec}>(
    ipcRenderer: Pick<IpcRenderer, 'invoke'>,
) {
    return function invoke<TChannel extends Extract<keyof TMap, string>>(
        channel: TChannel,
        ...args: TMap[TChannel]['args']
    ) {
        return invokeWithChannelContext<TMap[TChannel]['result']>(ipcRenderer, channel, args);
    };
}

export function createDecodedIpcInvoker<TMap extends {[TChannel in keyof TMap]: IIpcInvokeSpec}>(
    ipcRenderer: Pick<IpcRenderer, 'invoke'>,
) {
    return async function invokeDecoded<TChannel extends Extract<keyof TMap, string>>(
        channel: TChannel,
        decode: TIpcResultDecoder<TMap[TChannel]['result']>,
        ...args: TMap[TChannel]['args']
    ) {
        const result: unknown = await invokeWithChannelContext<unknown>(ipcRenderer, channel, args);
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
                }
            };
            ipcRenderer.on(channel, handler);
            return () => ipcRenderer.removeListener(channel, handler);
        },
    };
}
