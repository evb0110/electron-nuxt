import type {
    IpcMainInvokeEvent,
    IpcRenderer,
} from 'electron';
import type {
    IIpcInvokeSpec,
    TIpcCodecMap,
} from '@contracts/ipcMain';
import type { IValidatedIpcMainRegistrar } from '@electron/platform-ipc/validatedIpcRegistrar';
import {vi} from 'vitest';
import {
    createHarnessEvent,
    createValidatedRegistrarHarness,
    getCapturedIpcHandler,
} from '@tests/unit/electron/helpers/validatedIpcRegistrarHarness';

interface IIpcRoundTripInvokeCall {
    args: unknown[];
    channel: string;
}

type TRendererListener = (event: unknown, ...args: unknown[]) => void;
type TTestIpcRenderer = Pick<IpcRenderer, 'invoke' | 'on' | 'postMessage' | 'removeListener' | 'send'>;

export function createInProcessIpcRoundTripHarness<
    TMap extends {[TChannel in keyof TMap]: IIpcInvokeSpec},
    TService,
    TClient,
>(options: {
    channels: Record<string, string>;
    codecs: TIpcCodecMap<TMap>;
    createClient: (ipcRenderer: TTestIpcRenderer) => TClient;
    event?: IpcMainInvokeEvent;
    postMessage?: (channel: string, message: unknown, transfer?: MessagePort[]) => void;
    register: (registrar: IValidatedIpcMainRegistrar<TMap, IpcMainInvokeEvent>, service: TService) => void;
    service: TService;
}) {
    const handlers = createValidatedRegistrarHarness(options);
    const event = options.event ?? createHarnessEvent();
    const invokeCalls: IIpcRoundTripInvokeCall[] = [];
    const listeners = new Map<string, Set<TRendererListener>>();
    const on = vi.fn();
    const removeListener = vi.fn();
    const ipcRenderer = {
        invoke: async (channel: string, ...args: unknown[]) => {
            invokeCalls.push({
                args,
                channel,
            });
            const result = await getCapturedIpcHandler(handlers, channel)(event, ...structuredClone(args));
            return structuredClone(result);
        },
        on,
        postMessage: (channel: string, message: unknown, transfer?: MessagePort[]) => {
            if (options.postMessage) {
                options.postMessage(channel, structuredClone(message), transfer);
                return;
            }
            throw new Error(`Unsupported fake IPC postMessage call: ${channel}`);
        },
        removeListener,
        send: () => undefined,
    } satisfies TTestIpcRenderer;
    on.mockImplementation((channel: string, listener: TRendererListener) => {
        const channelListeners = listeners.get(channel) ?? new Set();
        channelListeners.add(listener);
        listeners.set(channel, channelListeners);
        return ipcRenderer;
    });
    removeListener.mockImplementation((channel: string, listener: TRendererListener) => {
        listeners.get(channel)?.delete(listener);
        return ipcRenderer;
    });

    return {
        client: options.createClient(ipcRenderer),
        emit: (channel: string, ...args: unknown[]) => {
            for (const listener of listeners.get(channel) ?? []) {
                // Renderer callbacks cannot observe the Electron event object in this client API.
                listener({}, ...args);
            }
        },
        event,
        handlers,
        invokeCalls,
        ipcRenderer,
    };
}
