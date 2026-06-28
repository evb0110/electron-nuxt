import type { IpcMainInvokeEvent } from 'electron';
import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    AGENT_CHANNELS,
    type IAgentInvokeMap,
} from '@electron/features/agent/contract';
import {
    registerAgentIpcAdapter,
    type TAgentIpcMainRegistrar,
} from '@electron/features/agent/registerAgentIpcAdapter';
import type { IAgentService } from '@electron/features/agent/ports';
import { cast } from '@tests/helpers/cast';

const mocks = vi.hoisted(() => ({
    fromWebContents: vi.fn(),
    createAgentService: vi.fn(),
}));

vi.mock('electron', () => ({
    BrowserWindow: {fromWebContents: mocks.fromWebContents},
    ipcMain: {handle: vi.fn()},
}));

vi.mock('@electron/features/agent/createAgentService', () => ({createAgentService: mocks.createAgentService}));

type TAgentHandler = (
    event: IpcMainInvokeEvent,
    ...args: unknown[]
) => unknown;

function createRegistrar() {
    const handlers = new Map<string, TAgentHandler>();
    const handle = (channel: string, handler: TAgentHandler) => {
        handlers.set(channel, handler);
    };
    const registrar = cast<TAgentIpcMainRegistrar>({handle});
    return {
        handlers,
        registrar,
    };
}

function createService() {
    return cast<IAgentService>({
        getMcpIntegrationStatus: vi.fn(async () => ({
            enabled: false,
            running: false,
            codexRegistrationState: 'unknown',
        })),
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
        shutdownAssistant: vi.fn(async () => undefined),
    });
}

function createEvent(id = 27) {
    return cast<IpcMainInvokeEvent>({sender: {id}});
}

function getHandler(
    handlers: Map<string, TAgentHandler>,
    channel: keyof IAgentInvokeMap,
) {
    const handler = handlers.get(channel);
    expect(handler).toBeTypeOf('function');
    return handler!;
}

describe('agent IPC adapter', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('registers every Agent invoke channel through the feature adapter', () => {
        const {
            handlers,
            registrar,
        } = createRegistrar();

        registerAgentIpcAdapter(registrar, createService());

        expect([...handlers.keys()].sort()).toEqual(Object.values(AGENT_CHANNELS).sort());
    });

    it('forwards the raw invoke event context for workspace responses', async () => {
        const {
            handlers,
            registrar,
        } = createRegistrar();
        const service = createService();
        const parentWindow = {id: 7};
        const event = createEvent(42);
        const response = {
            requestId: 'snapshot-1',
            ok: false,
            error: 'nope',
        };
        mocks.fromWebContents.mockReturnValue(parentWindow);

        registerAgentIpcAdapter(registrar, service);
        await getHandler(handlers, AGENT_CHANNELS.submitWorkspaceSnapshot)(event, response);

        expect(service.submitWorkspaceSnapshot).toHaveBeenCalledWith({
            event,
            sender: event.sender,
            senderId: 42,
            parentWindow,
        }, response);
    });

    it('rejects malformed assistant messages before calling the service', () => {
        const {
            handlers,
            registrar,
        } = createRegistrar();
        const service = createService();

        registerAgentIpcAdapter(registrar, service);

        expect(() => getHandler(handlers, AGENT_CHANNELS.sendAssistantMessage)(
            createEvent(),
            {
                text: 'hello',
                attachments: [{type: 'image'}],
            },
        )).toThrow('Invalid assistant message payload');
        expect(service.sendAssistantMessage).not.toHaveBeenCalled();
    });
});
