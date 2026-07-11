// @vitest-environment happy-dom

import {
    createApp,
    defineComponent,
    h,
    nextTick,
} from 'vue';
import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type {
    IAgentAssistantEvent,
    IAgentAssistantInstallResult,
    IAgentAssistantState,
} from '@contracts/agent';
import { createEmptyAssistantState } from '@app/modules/agent-panel/utils/createEmptyAssistantState';
import { useAgentAssistantPanelController } from '@app/modules/agent-panel/composables/useAgentAssistantPanelController';

const mocks = vi.hoisted(() => ({
    eventSubscriber: null as ((event: IAgentAssistantEvent) => void) | null,
    getAssistantState: vi.fn(),
    installAssistantCodex: vi.fn(),
    sendAssistantMessage: vi.fn(),
    interruptAssistant: vi.fn(),
}));

vi.mock('@app/utils/getAgentCapability', () => ({getAgentCapability: () => ({
    getAssistantState: mocks.getAssistantState,
    sendAssistantMessage: mocks.sendAssistantMessage,
    interruptAssistant: mocks.interruptAssistant,
    resetAssistantChat: vi.fn(),
    installAssistantCodex: mocks.installAssistantCodex,
    startAssistantLogin: vi.fn(),
    cancelAssistantLogin: vi.fn(),
    onAssistantEvent: (subscriber: (event: IAgentAssistantEvent) => void) => {
        mocks.eventSubscriber = subscriber;
        return () => {
            mocks.eventSubscriber = null;
        };
    },
})}));
vi.mock('@app/composables/useTypedI18n', () => ({useTypedI18n: () => ({t: (key: string) => key})}));
vi.mock('@app/composables/useRuntimeErrorReports', () => ({useRuntimeErrorReports: () => ({reportRuntimeError: vi.fn()})}));

const scope = {
    kind: 'document',
    key: 'document-a',
    title: 'Document A',
    tabId: 'tab-a',
} as const;

function createReadyState(phase: IAgentAssistantState['status']['turn']['phase'] = 'streaming') {
    const state = createEmptyAssistantState({
        chatScope: scope,
        selectedProvider: 'codex',
        selectedModel: 'gpt-5.4',
        selectedEffort: 'medium',
        selectedSpeedMode: 'standard',
    });
    state.status = {
        ...state.status,
        installState: 'installed',
        authState: 'signed-in',
        runtimeState: phase === 'stalled' ? 'error' : 'busy',
        turn: {
            ...state.status.turn,
            id: 'turn-1',
            phase,
            reasoning: 'Inspecting document',
            lastEventAtMs: Date.now(),
        },
        ...(phase === 'stalled'
            ? {
                error: 'No assistant signal received.',
                errorEnvelope: {
                    code: 'INTERNAL' as const,
                    message: 'No assistant signal received.',
                    retryable: true,
                    timestamp: Date.now(),
                },
            }
            : {}),
    };
    state.messages = [
        {
            id: 'user-1',
            role: 'user',
            text: 'Summarize this document',
            createdAt: new Date(0).toISOString(),
        },
        {
            id: 'assistant-1',
            role: 'assistant',
            text: 'Initial',
            pending: phase !== 'stalled',
            createdAt: new Date(1).toISOString(),
        },
    ];
    return state;
}

function createUpdateState() {
    const state = createReadyState('idle');
    state.status = {
        ...state.status,
        codexVersion: '0.132.0',
        codexVersionSupported: false,
        authState: 'unknown',
        runtimeState: 'stopped',
    };
    state.messages = [];
    return state;
}

async function mountHarness(initialState: IAgentAssistantState) {
    mocks.getAssistantState.mockResolvedValue(initialState);
    mocks.interruptAssistant.mockResolvedValue(createReadyState('cancelled'));
    mocks.sendAssistantMessage.mockResolvedValue({
        ok: true,
        state: createReadyState('queued'),
    });
    const host = document.createElement('div');
    document.body.append(host);
    const Harness = defineComponent({setup() {
        const controller = useAgentAssistantPanelController({
            chatScope: scope,
            activeDocumentName: 'Document A',
            hasActiveDocument: true,
            hasAnyDocument: true,
        });
        return () => h('section', [
            h('output', {class: 'phase'}, controller.status.value.turn.phase),
            h('output', {class: 'reasoning'}, controller.turnReasoning.value),
            h('output', {class: 'panel-view'}, controller.panelView.value),
            h('output', {class: 'install-progress'}, controller.installProgress.value),
            h('output', {class: 'install-error'}, controller.status.value.error),
            h('output', {class: 'installing'}, String(controller.isInstalling.value)),
            h('button', {
                class: 'install',
                onClick: controller.handleInstallCodex,
            }, 'Install'),
            h('div', {
                class: 'messages',
                ref: controller.messagesRef,
            }, controller.renderedMessages.value.map(
                ({message}) => h('p', {key: message.id}, message.text),
            )),
            controller.canRetryAssistantError.value
                ? h('button', {
                    class: 'retry',
                    onClick: controller.retryLastAssistantMessage,
                }, 'Retry')
                : null,
        ]);
    }});
    const app = createApp(Harness);
    app.mount(host);
    await nextTick();
    await nextTick();
    return {
        app,
        host,
        unmount() {
            app.unmount();
            host.remove();
        },
    };
}

describe('mounted assistant panel lifecycle', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.eventSubscriber = null;
    });

    it('renders a stalled turn and retries the last user message', async () => {
        const harness = await mountHarness(createReadyState('stalled'));
        expect(harness.host.querySelector('.phase')?.textContent).toBe('stalled');
        expect(harness.host.querySelector('.reasoning')?.textContent).toBe('Inspecting document');

        (harness.host.querySelector('.retry') as HTMLButtonElement).click();
        await nextTick();
        await nextTick();

        expect(mocks.sendAssistantMessage).toHaveBeenCalledWith(expect.objectContaining({
            text: 'Summarize this document',
            scope,
        }));
        harness.unmount();
    });

    it('keeps the reader position while streaming when the message list is not near the bottom', async () => {
        const harness = await mountHarness(createReadyState());
        const messages = harness.host.querySelector('.messages') as HTMLDivElement;
        Object.defineProperties(messages, {
            scrollHeight: {
                configurable: true,
                value: 1_000,
            },
            clientHeight: {
                configurable: true,
                value: 100,
            },
        });
        messages.scrollTop = 120;

        mocks.eventSubscriber?.({
            type: 'message-delta',
            state: createReadyState(),
            messageId: 'assistant-1',
            delta: ' streamed',
        });
        await nextTick();

        expect(messages.scrollTop).toBe(120);
        expect(harness.host.textContent).toContain('Initial streamed');
        harness.unmount();
    });

    it('shows accepted install progress and returns a failed update to a retryable state', async () => {
        let resolveInstall: (result: IAgentAssistantInstallResult) => void = () => undefined;
        mocks.installAssistantCodex.mockReturnValue(new Promise<IAgentAssistantInstallResult>(resolve => {
            resolveInstall = resolve;
        }));
        const updateState = createUpdateState();
        const harness = await mountHarness(updateState);

        (harness.host.querySelector('.install') as HTMLButtonElement).click();
        await nextTick();
        expect(harness.host.querySelector('.installing')?.textContent).toBe('true');

        mocks.eventSubscriber?.({
            type: 'install-progress',
            progress: 'Downloading verified Codex.',
            state: updateState,
        });
        await nextTick();
        expect(harness.host.querySelector('.install-progress')?.textContent).toBe('Downloading verified Codex.');

        const failedUpdateState = createUpdateState();
        failedUpdateState.status.error = 'The Codex download timed out.';
        resolveInstall({
            ok: false,
            state: failedUpdateState,
            error: 'The Codex download timed out.',
        });
        await nextTick();
        await nextTick();

        expect(harness.host.querySelector('.panel-view')?.textContent).toBe('update');
        expect(harness.host.querySelector('.installing')?.textContent).toBe('false');
        expect(harness.host.querySelector('.install-error')?.textContent).toBe('The Codex download timed out.');
        harness.unmount();
    });
});
