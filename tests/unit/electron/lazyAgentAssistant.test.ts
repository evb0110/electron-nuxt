import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const mocks = vi.hoisted(() => ({
    moduleLoads: 0,
    initializeAgentAssistantRuntime: vi.fn(),
    getAgentAssistantState: vi.fn(async () => ({status: 'ready'})),
    shutdownAgentAssistant: vi.fn(async () => {}),
}));

vi.mock('@electron/features/agent/codexAssistant', () => {
    mocks.moduleLoads += 1;
    return {
        initializeAgentAssistantRuntime: mocks.initializeAgentAssistantRuntime,
        getAgentAssistantState: mocks.getAgentAssistantState,
        installAgentAssistantCodex: vi.fn(),
        startAgentAssistantLogin: vi.fn(),
        cancelAgentAssistantLogin: vi.fn(),
        sendAgentAssistantMessage: vi.fn(),
        interruptAgentAssistant: vi.fn(),
        resetAgentAssistantChat: vi.fn(),
        shutdownAgentAssistant: mocks.shutdownAgentAssistant,
    };
});

describe('lazyAgentAssistant', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        mocks.moduleLoads = 0;
    });

    it('does not load the assistant runtime only to shut down', async () => {
        const {shutdownAgentAssistantIfLoaded} = await import(
            '@electron/features/agent/lazyAgentAssistant'
        );

        await shutdownAgentAssistantIfLoaded();

        expect(mocks.moduleLoads).toBe(0);
        expect(mocks.shutdownAgentAssistant).not.toHaveBeenCalled();
    });

    it('loads one runtime module on first use and reuses it after shutdown', async () => {
        const {
            getAgentAssistantState,
            shutdownAgentAssistantIfLoaded,
        } = await import('@electron/features/agent/lazyAgentAssistant');

        await Promise.all([
            getAgentAssistantState(),
            getAgentAssistantState(),
        ]);
        await shutdownAgentAssistantIfLoaded();
        await getAgentAssistantState();

        expect(mocks.moduleLoads).toBe(1);
        expect(mocks.initializeAgentAssistantRuntime).toHaveBeenCalledTimes(3);
        expect(mocks.getAgentAssistantState).toHaveBeenCalledTimes(3);
        expect(mocks.shutdownAgentAssistant).toHaveBeenCalledOnce();
    });
});
