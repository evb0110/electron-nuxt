import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { createAssistantChatSessionStore } from '@electron/features/agent/assistantChatSessionStore';
import { createAssistantProviderRuntimeStates } from '@electron/features/agent/assistantProviderState';
import { createAssistantRuntimeLifecycle } from '@electron/features/agent/assistantRuntimeLifecycle';
import {
    claimAssistantTurn,
    supersedeAssistantTurn,
} from '@electron/features/agent/assistantTurnLifecycle';

const mocks = vi.hoisted(() => ({refreshCodexAuthStateAndRuntimeAvailability: vi.fn(async () => undefined)}));

vi.mock('electron', () => ({app: {
    getPath: () => '/tmp/evb-viewer',
    getVersion: () => 'test',
}}));

vi.mock('@electron/features/agent/assistantProviderAccounts', () => ({
    refreshCodexAuthState: vi.fn(async () => undefined),
    refreshCodexAuthStateAndRuntimeAvailability: mocks.refreshCodexAuthStateAndRuntimeAvailability,
    syncCodexRuntimeStateAfterAuthCheck: vi.fn(),
}));

describe('assistant runtime lifecycle', () => {
    it('holds busy state for active work and repairs it after every session becomes terminal', async () => {
        const sessionStore = createAssistantChatSessionStore({persistence: false});
        const session = sessionStore.getSession({
            kind: 'document',
            key: 'document-a',
            title: 'Document A',
            tabId: 'tab-a',
        }, {
            provider: 'codex',
            model: 'gpt-5.4',
            effort: 'medium',
            speedMode: 'standard',
        }, {create: true});
        const providerRuntime = createAssistantProviderRuntimeStates({codex: {
            authState: 'signed-in',
            runtimeState: 'busy',
        }}).codex;
        const logger = {
            info: vi.fn(),
            warn: vi.fn(),
        };
        const lifecycle = createAssistantRuntimeLifecycle({
            providerRuntime,
            sessionStore,
            getCodexModels: () => [],
            setCodexModels: vi.fn(),
            isAssistantFeatureEnabled: vi.fn(async () => true),
            createAssistantDisabledError: () => 'disabled',
            shutdownAssistant: vi.fn(async () => undefined),
            publishCodexState: vi.fn(),
            handleNotification: vi.fn(),
            handleExit: vi.fn(),
            logger,
        });

        session.sendInFlight = Promise.resolve();
        await lifecycle.refreshAuthStateAndRuntimeAvailability();
        expect(providerRuntime.runtimeState).toBe('busy');

        session.sendInFlight = null;
        session.turnOwner = claimAssistantTurn(session.turnOwner, {
            sessionKey: 'codex:document-a',
            scopeKey: 'document-a',
            provider: 'codex',
            windowId: 1,
            tabId: 'tab-a',
            documentRef: null,
            documentIdentity: null,
        });
        await lifecycle.refreshAuthStateAndRuntimeAvailability();
        expect(providerRuntime.runtimeState).toBe('busy');

        session.turnOwner = supersedeAssistantTurn(session.turnOwner);
        await lifecycle.refreshAuthStateAndRuntimeAvailability();
        expect(providerRuntime.runtimeState).toBe('stopped');
        expect(logger.warn).toHaveBeenCalledWith(
            'Recovered an orphaned Codex busy state after all assistant turns became terminal.',
        );
    });
});
