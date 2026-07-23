import type {
    IpcMainInvokeEvent,
    IpcRenderer,
} from 'electron';
import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type { IIpcMainRegistrar } from '@contracts/ipcMain';
import {
    CORE_IPC_CHANNELS,
    type ICoreInvokeMap,
} from '@electron/platform-ipc/coreContract';
import { CORE_IPC_CODECS } from '@electron/platform-ipc/coreIpcCodecs';
import { createValidatedIpcMainRegistrar } from '@electron/platform-ipc/validatedIpcRegistrar';
import { createCodecIpcInvoker } from '@electron/preload/ipcClient';
import { cast } from '@tests/helpers/cast';

const mocks = vi.hoisted(() => ({isTrustedIpcInvokeSender: vi.fn(() => true)}));

vi.mock('@electron/platform-ipc/trustedIpcSender', () => ({
    isTrustedIpcInvokeSender: mocks.isTrustedIpcInvokeSender,
    isTrustedWebContentsSender: vi.fn(() => true),
}));

type TCoreChannel = Extract<keyof ICoreInvokeMap, string>;
type TRegisteredHandler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;

const checkpoint = {
    version: 1 as const,
    capturedAt: 1,
    activePaneId: null,
    activeTabId: null,
    layout: null,
    panes: [],
    tabs: [],
};
const transferRequest = {
    target: {
        kind: 'window' as const,
        windowId: 2,
    },
    tab: {
        fileName: 'sample.pdf',
        originalPath: '/tmp/sample.pdf',
        isDirty: false,
        isDjvu: false,
    },
    payload: {
        kind: 'pdfSnapshot' as const,
        fileName: 'sample.pdf',
        originalPath: '/tmp/sample.pdf',
        snapshotPath: '/tmp/snapshot.pdf',
        isDirty: false,
    },
};
const updateStatus = {
    phase: 'idle' as const,
    origin: 'auto' as const,
    version: null,
    percent: null,
    message: null,
};

const cases = [
    {
        channel: CORE_IPC_CHANNELS.updatesGetState,
        args: [],
        result: updateStatus,
        invalidArg: 'extra',
    },
    {
        channel: CORE_IPC_CHANNELS.updatesCheck,
        args: [],
        result: {started: true},
        invalidArg: 'extra',
    },
    {
        channel: CORE_IPC_CHANNELS.updatesDownload,
        args: [],
        result: {started: true},
        invalidArg: 'extra',
    },
    {
        channel: CORE_IPC_CHANNELS.updatesInstall,
        args: [],
        result: {started: false},
        invalidArg: 'extra',
    },
    {
        channel: CORE_IPC_CHANNELS.updatesDefer,
        args: [],
        result: undefined,
        invalidArg: 'extra',
    },
    {
        channel: CORE_IPC_CHANNELS.updatesSkipVersion,
        args: ['2.0.0'],
        result: undefined,
        invalidArg: 2,
    },
    {
        channel: CORE_IPC_CHANNELS.windowCloseCurrent,
        args: [],
        result: true,
        invalidArg: 'extra',
    },
    {
        channel: CORE_IPC_CHANNELS.claimPendingExternalOpenPaths,
        args: [],
        result: ['/tmp/a.pdf'],
        invalidArg: 'extra',
    },
    {
        channel: CORE_IPC_CHANNELS.acknowledgePendingExternalOpenPaths,
        args: [['/tmp/a.pdf']],
        result: undefined,
        invalidArg: [3],
    },
    {
        channel: CORE_IPC_CHANNELS.workspaceCheckpointSave,
        args: [checkpoint],
        result: undefined,
        invalidArg: null,
    },
    {
        channel: CORE_IPC_CHANNELS.workspaceCheckpointClaim,
        args: [],
        result: checkpoint,
        invalidArg: 'extra',
    },
    {
        channel: CORE_IPC_CHANNELS.tabsTransfer,
        args: [transferRequest],
        result: {
            transferId: 'transfer-1',
            success: true,
            targetWindowId: 2,
        },
        invalidArg: null,
    },
    {
        channel: CORE_IPC_CHANNELS.tabsTransferAck,
        args: [{
            transferId: 'transfer-1',
            success: true,
        }],
        result: true,
        invalidArg: {
            transferId: '',
            success: true,
        },
    },
    {
        channel: CORE_IPC_CHANNELS.tabsListTargets,
        args: [],
        result: [{
            windowId: 2,
            label: 'Window 2',
        }],
        invalidArg: 'extra',
    },
    {
        channel: CORE_IPC_CHANNELS.tabsShowContextMenu,
        args: ['tab-1'],
        result: undefined,
        invalidArg: '',
    },
    {
        channel: CORE_IPC_CHANNELS.hostGetEnvironment,
        args: [],
        result: {
            platform: 'linux',
            osScaleFactor: 1,
        },
        invalidArg: 'extra',
    },
    {
        channel: CORE_IPC_CHANNELS.hostGetZenModeState,
        args: [],
        result: {
            active: false,
            supported: true,
        },
        invalidArg: 'extra',
    },
    {
        channel: CORE_IPC_CHANNELS.hostSetZenMode,
        args: [true],
        result: {
            active: true,
            supported: true,
        },
        invalidArg: 'true',
    },
] as const satisfies ReadonlyArray<{
    args: readonly unknown[];
    channel: TCoreChannel;
    invalidArg: unknown;
    result: unknown;
}>;

const invalidResults: Record<TCoreChannel, unknown> = Object.fromEntries(
    cases.map(({
        channel,
        result,
    }) => [
        channel,
        result === undefined ? null : undefined,
    ]),
) as Record<TCoreChannel, unknown>;

function createRoundTrip() {
    const handlers = new Map<string, TRegisteredHandler>();
    const nativeRegistrar = cast<IIpcMainRegistrar<never, IpcMainInvokeEvent>>({handle: (channel: string, handler: TRegisteredHandler) => handlers.set(channel, handler)});
    const registrar = createValidatedIpcMainRegistrar<ICoreInvokeMap>(nativeRegistrar, {
        allowedChannels: new Set(cases.map(testCase => testCase.channel)),
        codecs: CORE_IPC_CODECS,
    });
    const register = cast<(
        channel: TCoreChannel,
        handler: (event: IpcMainInvokeEvent, ...args: never[]) => unknown,
    ) => void>(registrar.handle);
    for (const testCase of cases) {
        register(testCase.channel, () => testCase.result);
    }
    const event = cast<IpcMainInvokeEvent>({sender: {id: 7}});
    const ipcRenderer = cast<IpcRenderer>({invoke: async (channel: string, ...args: unknown[]) => {
        const handler = handlers.get(channel);
        if (!handler) {
            throw new Error(`Missing handler for ${channel}`);
        }
        return handler(event, ...args);
    }});
    return {
        event,
        handlers,
        invoke: createCodecIpcInvoker<ICoreInvokeMap>(ipcRenderer, CORE_IPC_CODECS),
    };
}

describe('core IPC canonical codec round trips', () => {
    const roundTrip = createRoundTrip();

    beforeEach(() => mocks.isTrustedIpcInvokeSender.mockReturnValue(true));

    it('defines one codec and completes a validated registrar/preload round trip for every core invoke channel', async () => {
        expect(Object.keys(CORE_IPC_CODECS).sort()).toEqual(cases.map(testCase => testCase.channel).sort());
        const {invoke} = roundTrip;

        for (const testCase of cases) {
            await expect(
                (invoke as (channel: TCoreChannel, ...args: unknown[]) => Promise<unknown>)(
                    testCase.channel,
                    ...testCase.args,
                ),
                testCase.channel,
            ).resolves.toEqual(testCase.result);
        }
    });

    it('rejects every malformed argument position and every extra argument before the handler', async () => {
        const {
            event,
            handlers,
        } = roundTrip;
        for (const testCase of cases) {
            const handler = handlers.get(testCase.channel);
            expect(handler, testCase.channel).toBeDefined();
            const malformedArgs = testCase.args.length === 0
                ? [testCase.invalidArg]
                : [
                    testCase.invalidArg,
                    ...testCase.args.slice(1),
                ];
            await expect(handler?.(event, ...malformedArgs), testCase.channel)
                .rejects.toThrow(`Invalid IPC arguments for ${testCase.channel}`);
            await expect(handler?.(event, ...testCase.args, 'extra'), testCase.channel)
                .rejects.toThrow(`Invalid IPC arguments for ${testCase.channel}`);
        }
    });

    it('rejects an untrusted sender on every core invoke channel', async () => {
        const {
            event,
            handlers,
        } = roundTrip;
        mocks.isTrustedIpcInvokeSender.mockReturnValue(false);
        for (const testCase of cases) {
            await expect(handlers.get(testCase.channel)?.(event, ...testCase.args), testCase.channel)
                .rejects.toThrow('IPC sender is not trusted');
        }
    });

    it('rejects malformed main-process results in the preload codec for every core invoke channel', async () => {
        const ipcRenderer = cast<IpcRenderer>({invoke: async (channel: TCoreChannel) => invalidResults[channel]});
        const invoke = createCodecIpcInvoker<ICoreInvokeMap>(ipcRenderer, CORE_IPC_CODECS);
        for (const testCase of cases) {
            await expect(
                (invoke as (channel: TCoreChannel, ...args: unknown[]) => Promise<unknown>)(
                    testCase.channel,
                    ...testCase.args,
                ),
                testCase.channel,
            ).rejects.toThrow(`Invalid IPC response for ${testCase.channel}`);
        }
    });
});
