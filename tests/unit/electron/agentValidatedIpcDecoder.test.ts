import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type {IAgentService} from '@electron/features/agent/ports';
import type {IAgentInvokeMap} from '@electron/features/agent/contract';
import {cast} from '@tests/helpers/cast';
import {
    createHarnessEvent,
    createValidatedRegistrarHarness,
    getCapturedIpcHandler,
    type IValidatedRegistrarCase,
} from '@tests/unit/electron/helpers/validatedIpcRegistrarHarness';

const mocks = vi.hoisted(() => ({isTrustedIpcInvokeSender: vi.fn(() => true)}));

vi.mock('electron', () => ({
    BrowserWindow: {fromWebContents: () => null},
    ipcMain: {handle: vi.fn()},
}));
vi.mock('@electron/platform-ipc/trustedIpcSender', () => mocks);
vi.mock('@electron/features/agent/createAgentService', () => ({createAgentService: vi.fn()}));

function createService() {
    return cast<IAgentService>({
        getMcpIntegrationStatus: vi.fn(),
        setMcpIntegrationEnabled: vi.fn(),
        getAssistantState: vi.fn(),
        installAssistantCodex: vi.fn(),
        startAssistantLogin: vi.fn(),
        cancelAssistantLogin: vi.fn(),
        sendAssistantMessage: vi.fn(),
        interruptAssistant: vi.fn(),
        resetAssistantChat: vi.fn(),
        submitWorkspaceSnapshot: vi.fn(),
        submitCommandResponse: vi.fn(),
        shutdownAssistant: vi.fn(),
    });
}

describe('agent validated IPC decoder', () => {
    it('routes every channel through the real registrar and rejects malformed tuples and senders', async () => {
        const {AGENT_CHANNELS} = await import('@electron/features/agent/contract');
        const {AGENT_IPC_CODECS} = await import('@electron/features/agent/agentIpcCodecs');
        const {registerAgentIpcAdapter} = await import('@electron/features/agent/registerAgentIpcAdapter');
        const service = createService();
        const cases: IValidatedRegistrarCase[] = [
            {
                channel: AGENT_CHANNELS.getMcpIntegrationStatus,
                validArgs: [],
            },
            {
                channel: AGENT_CHANNELS.setMcpIntegrationEnabled,
                validArgs: [true],
            },
            {
                channel: AGENT_CHANNELS.getAssistantState,
                validArgs: [],
            },
            {
                channel: AGENT_CHANNELS.installAssistantCodex,
                validArgs: [],
            },
            {
                channel: AGENT_CHANNELS.startAssistantLogin,
                validArgs: [{mode: 'chatgpt'}],
            },
            {
                channel: AGENT_CHANNELS.cancelAssistantLogin,
                validArgs: [],
            },
            {
                channel: AGENT_CHANNELS.sendAssistantMessage,
                validArgs: [{text: 'hello'}],
            },
            {
                channel: AGENT_CHANNELS.interruptAssistant,
                validArgs: [],
            },
            {
                channel: AGENT_CHANNELS.resetAssistantChat,
                validArgs: [],
            },
            {
                channel: AGENT_CHANNELS.submitWorkspaceSnapshot,
                validArgs: [{
                    requestId: 'snapshot-1',
                    ok: false,
                }],
            },
            {
                channel: AGENT_CHANNELS.submitCommandResponse,
                validArgs: [{
                    requestId: 'command-1',
                    ok: false,
                }],
            },
        ];
        const handlers = createValidatedRegistrarHarness<IAgentInvokeMap, IAgentService>({
            channels: AGENT_CHANNELS,
            codecs: AGENT_IPC_CODECS,
            register: registerAgentIpcAdapter,
            service,
        });

        expect([...handlers.keys()].sort()).toEqual(Object.values(AGENT_CHANNELS).sort());
        for (const testCase of cases) {
            const handler = getCapturedIpcHandler(handlers, testCase.channel);
            mocks.isTrustedIpcInvokeSender.mockReturnValue(true);
            await expect(handler(createHarnessEvent(), ...testCase.validArgs)).resolves.not.toThrow();

            for (let index = 0; index < testCase.validArgs.length; index += 1) {
                const malformedArgs = [...testCase.validArgs];
                malformedArgs[index] = Symbol('malformed');
                await expect(handler(createHarnessEvent(), ...malformedArgs)).rejects.toThrow(
                    `Invalid IPC arguments for ${testCase.channel}`,
                );
            }
            await expect(handler(createHarnessEvent(), ...testCase.validArgs, 'extra')).rejects.toThrow(
                `Invalid IPC arguments for ${testCase.channel}`,
            );

            mocks.isTrustedIpcInvokeSender.mockReturnValue(false);
            await expect(handler(createHarnessEvent(), ...testCase.validArgs)).rejects.toThrow('IPC sender is not trusted');
        }
    });
});
