import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { createAssistantChatSessionStore } from '@electron/features/agent/assistantChatSessionStore';
import { createClaudeTurnPresentationCallbacks } from '@electron/features/agent/createClaudeTurnPresentationCallbacks';

describe('Claude turn presentation callbacks', () => {
    it('projects tool activity and usage through the shared assistant turn model', () => {
        const store = createAssistantChatSessionStore({persistence: false});
        const session = store.getSession({
            kind: 'document',
            key: 'document-a',
            title: 'Document A',
            tabId: 'tab-a',
        }, {
            provider: 'claude',
            model: 'claude-sonnet-4-6',
            effort: 'medium',
            speedMode: 'standard',
        }, {create: true});
        const publish = vi.fn();
        const callbacks = createClaudeTurnPresentationCallbacks({
            session,
            shouldDrop: () => false,
            publish,
        });

        callbacks.onToolActivity('turn-1', {
            toolId: 'tool-1',
            name: 'document.search',
            phase: 'running',
        });
        callbacks.onToolActivity('turn-1', {
            toolId: 'tool-1',
            name: 'document.search',
            phase: 'completed',
        });
        callbacks.onUsage('turn-1', {
            inputTokens: 14,
            outputTokens: 6,
            cachedInputTokens: 4,
        });

        expect(session.turnPresentation).toMatchObject({
            phase: 'finalizing',
            usage: {
                inputTokens: 14,
                outputTokens: 6,
                cachedInputTokens: 4,
            },
            toolActivity: [{
                toolId: 'tool-1',
                name: 'document.search',
                phase: 'completed',
            }],
        });
        expect(publish).toHaveBeenLastCalledWith(expect.objectContaining({
            type: 'turn-progress',
            phase: 'finalizing',
            toolActivity: expect.objectContaining({phase: 'completed'}),
        }));
    });
});
