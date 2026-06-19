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

export function createTypedIpcInvoker<TMap extends {[TChannel in keyof TMap]: IIpcInvokeSpec}>(
    ipcRenderer: Pick<IpcRenderer, 'invoke'>,
) {
    return function invoke<TChannel extends Extract<keyof TMap, string>>(
        channel: TChannel,
        ...args: TMap[TChannel]['args']
    ) {
        return ipcRenderer.invoke(channel, ...args) as Promise<TMap[TChannel]['result']>;
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
        const result: unknown = await ipcRenderer.invoke(channel, ...args);
        const decoded = decode(result);
        if (decoded === null) {
            throw new Error(`Invalid IPC response for ${channel}`);
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
    };
}
