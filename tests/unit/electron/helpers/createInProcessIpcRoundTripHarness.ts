import type {
    IpcMainInvokeEvent,
    IpcRenderer,
    IpcRendererEvent,
} from 'electron';
import type {
    IIpcInvokeSpec,
    TIpcCodecMap,
} from '@contracts/ipcMain';
import type { IValidatedIpcMainRegistrar } from '@electron/platform-ipc/validatedIpcRegistrar';
import { cast } from '@tests/helpers/cast';
import {
    createHarnessEvent,
    createValidatedRegistrarHarness,
    getCapturedIpcHandler,
} from '@tests/unit/electron/helpers/validatedIpcRegistrarHarness';

export interface IIpcRoundTripInvokeCall {
    args: unknown[];
    channel: string;
}

export function createInProcessIpcRoundTripHarness<
    TMap extends {[TChannel in keyof TMap]: IIpcInvokeSpec},
    TService,
    TClient,
>(options: {
    channels: Record<string, string>;
    codecs: TIpcCodecMap<TMap>;
    createClient: (ipcRenderer: IpcRenderer) => TClient;
    event?: IpcMainInvokeEvent;
    postMessage?: (channel: string, message: unknown, transfer?: MessagePort[]) => void;
    register: (registrar: IValidatedIpcMainRegistrar<TMap, IpcMainInvokeEvent>, service: TService) => void;
    service: TService;
}) {
    const handlers = createValidatedRegistrarHarness(options);
    const event = options.event ?? createHarnessEvent();
    const invokeCalls: IIpcRoundTripInvokeCall[] = [];
    const listeners = new Map<string, Set<(event: IpcRendererEvent, ...args: unknown[]) => void>>();
    const renderer = {
        invoke: async (channel: string, ...args: unknown[]) => {
            invokeCalls.push({
                args,
                channel,
            });
            const result = await getCapturedIpcHandler(handlers, channel)(event, ...structuredClone(args));
            return structuredClone(result);
        },
        on: (channel: string, listener: (event: IpcRendererEvent, ...args: unknown[]) => void) => {
            const channelListeners = listeners.get(channel) ?? new Set();
            channelListeners.add(listener);
            listeners.set(channel, channelListeners);
            return ipcRenderer;
        },
        postMessage: (channel: string, message: unknown, transfer?: MessagePort[]) => {
            if (options.postMessage) {
                options.postMessage(channel, structuredClone(message), transfer);
                return;
            }
            throw new Error(`Unsupported fake IPC postMessage call: ${channel}`);
        },
        removeListener: (channel: string, listener: (event: IpcRendererEvent, ...args: unknown[]) => void) => {
            listeners.get(channel)?.delete(listener);
            return ipcRenderer;
        },
        send: () => undefined,
    };
    const ipcRenderer = cast<IpcRenderer>(renderer);

    return {
        client: options.createClient(ipcRenderer),
        emit: (channel: string, ...args: unknown[]) => {
            for (const listener of listeners.get(channel) ?? []) {
                listener(cast<IpcRendererEvent>({}), ...args);
            }
        },
        event,
        handlers,
        invokeCalls,
        ipcRenderer,
    };
}
