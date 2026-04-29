import type {
    IpcRenderer,
    IpcRendererEvent,
} from 'electron';
import type { IMenuEventUnsubscribe } from '@contracts/electron-api';

interface IInvokeSpec<TArgs extends unknown[] = unknown[], TResult = unknown> {
    args: TArgs;
    result: TResult;
}

type TNoArgEventChannel<TEventMap extends {[TChannel in keyof TEventMap]: unknown}> = Extract<{
    [TChannel in keyof TEventMap]: TEventMap[TChannel] extends undefined ? TChannel : never;
}[keyof TEventMap], string>;

type TPayloadEventChannel<TEventMap extends {[TChannel in keyof TEventMap]: unknown}> = Exclude<
    Extract<keyof TEventMap, string>,
    TNoArgEventChannel<TEventMap>
>;

export function createIpcInvoker(ipcRenderer: IpcRenderer) {
    return function invoke<TResult = unknown>(channel: string, ...args: unknown[]) {
        return ipcRenderer.invoke(channel, ...args) as Promise<TResult>;
    };
}

export function createTypedIpcInvoker<TMap extends {[TChannel in keyof TMap]: IInvokeSpec}>(ipcRenderer: IpcRenderer) {
    return function invoke<TChannel extends Extract<keyof TMap, string>>(
        channel: TChannel,
        ...args: TMap[TChannel]['args']
    ) {
        return ipcRenderer.invoke(channel, ...args) as Promise<TMap[TChannel]['result']>;
    };
}

export function createTypedIpcEventSubscriber<
    TEventMap extends {[TChannel in keyof TEventMap]: unknown},
>(ipcRenderer: IpcRenderer) {
    return {
        onNoArg<TChannel extends TNoArgEventChannel<TEventMap>>(
            channel: TChannel,
            callback: () => void,
        ): IMenuEventUnsubscribe {
            const handler = (_event: IpcRendererEvent) => callback();
            ipcRenderer.on(channel, handler);
            return () => ipcRenderer.removeListener(channel, handler);
        },

        onPayload<TChannel extends TPayloadEventChannel<TEventMap>>(
            channel: TChannel,
            callback: (payload: TEventMap[TChannel]) => void,
        ): IMenuEventUnsubscribe {
            const handler = (_event: IpcRendererEvent, payload: TEventMap[TChannel]) => callback(payload);
            ipcRenderer.on(channel, handler);
            return () => ipcRenderer.removeListener(channel, handler);
        },
    };
}
