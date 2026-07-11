import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type { IAgentAssistantState } from '@contracts/agent';
import type { IAssistantChatSession } from '@electron/features/agent/assistantChatSessionStore';
import { createAssistantEventPublisher } from '@electron/features/agent/createAssistantEventPublisher';
import { cast } from '@tests/helpers/cast';

const mocks = vi.hoisted(() => {
    const windows = new Map<number, {
        id: number;
        isDestroyed: () => boolean;
        webContents: {isDestroyed: () => boolean};
    }>();
    return {
        windows,
        send: vi.fn(),
    };
});

vi.mock('electron', () => ({BrowserWindow: {
    fromId: (id: number) => mocks.windows.get(id) ?? null,
    getAllWindows: () => [...mocks.windows.values()],
}}));
vi.mock('@electron/features/agent/main/agentRendererEvents', () => ({sendAgentAssistantEvent: mocks.send}));

function createWindow(id: number) {
    return {
        id,
        isDestroyed: () => false,
        webContents: {isDestroyed: () => false},
    };
}

describe('assistant event publisher', () => {
    beforeEach(() => {
        mocks.windows.clear();
        mocks.windows.set(1, createWindow(1));
        mocks.windows.set(2, createWindow(2));
        mocks.send.mockClear();
    });

    it('targets only the BrowserWindow bound to the producing session', () => {
        const scope = {
            kind: 'document' as const,
            key: 'document-a',
            title: 'A',
            documentSessionKey: 'session-a',
            documentRef: '/tmp/a.pdf',
        };
        const session = {
            provider: 'codex',
            scope,
            lastSenderWindowId: 2,
            turnOwner: {generation: 7},
        } as IAssistantChatSession;
        const state = cast<IAgentAssistantState>({scope});
        const publisher = createAssistantEventPublisher({
            currentState: () => state,
            getDefaultScope: () => scope,
            getDefaultSelection: () => session,
        });

        publisher.publishAssistantEvent({
            type: 'message-delta',
            messageId: 'message',
            delta: 'hello',
        }, scope, session);

        expect(mocks.send).toHaveBeenCalledTimes(1);
        expect(mocks.send.mock.calls[0]?.[0]).toBe(mocks.windows.get(2));
        expect(mocks.send.mock.calls[0]?.[1]).toMatchObject({binding: {
            sessionKey: 'codex:document-a',
            turnGeneration: 7,
            windowId: 2,
        }});
    });

    it('attaches state to unbound install progress so renderer event fences accept it', () => {
        const state = cast<IAgentAssistantState>({scope: null});
        const publisher = createAssistantEventPublisher({
            currentState: () => state,
            getDefaultScope: () => null,
            getDefaultSelection: () => cast<IAssistantChatSession>({
                provider: 'codex',
                lastSenderWindowId: null,
            }),
        });

        publisher.publishAssistantEvent({
            type: 'install-progress',
            progress: 'Downloading verified Codex.',
        });

        expect(mocks.send).toHaveBeenCalledTimes(2);
        expect(mocks.send.mock.calls[0]?.[1]).toMatchObject({
            type: 'install-progress',
            progress: 'Downloading verified Codex.',
            state,
        });
    });
});
