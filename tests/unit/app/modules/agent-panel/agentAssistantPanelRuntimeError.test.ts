// @vitest-environment happy-dom

import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    createApp,
    defineComponent,
    h,
} from 'vue';
import AgentAssistantPanel from '@app/modules/agent-panel/components/AgentAssistantPanel.vue';

const mocks = vi.hoisted(() => ({
    handleRefreshState: vi.fn(),
    panelRef: {
        __v_isRef: true,
        value: null,
    },
}));

vi.mock('@app/modules/agent-panel/composables/useAgentAssistantPanelController', () => ({useAgentAssistantPanelController: () => ({
    canResetChat: false,
    expandedImage: null,
    handleRefreshState: mocks.handleRefreshState,
    hasComposer: false,
    hasLoadedState: false,
    hasMessages: false,
    headerIcon: 'i-ph-chat-circle-dots',
    headerTitle: 'EVB Assistant',
    isResetting: false,
    isResizing: false,
    panelRef: mocks.panelRef,
    panelView: 'error',
    placeholderText: 'Ask EVB Assistant',
    status: {error: 'Codex app-server exited: invalid transport.'},
    t: (key: string) => key,
    widthVar: '22rem',
})}));

const ButtonStub = defineComponent({
    inheritAttrs: false,
    props: {label: {
        type: String,
        default: '',
    }},
    setup: (props, {attrs}) => () => h('button', {
        ...attrs,
        type: 'button',
    }, props.label),
});

const TooltipStub = defineComponent({
    props: {
        delayDuration: Number,
        text: String,
        usefulness: String,
    },
    setup: (_props, {slots}) => () => h('span', slots.default?.()),
});
const IconStub = defineComponent({setup: () => () => h('span')});
const activeUnmounts = new Set<() => void>();

function mountPanel() {
    const host = document.createElement('div');
    document.body.append(host);
    const app = createApp(AgentAssistantPanel);
    app.component('AppTooltip', TooltipStub);
    app.component('UButton', ButtonStub);
    app.component('UIcon', IconStub);
    app.mount(host);
    const unmount = () => {
        app.unmount();
        host.remove();
        activeUnmounts.delete(unmount);
    };
    activeUnmounts.add(unmount);
    return host;
}

afterEach(() => {
    for (const unmount of [...activeUnmounts]) {
        unmount();
    }
    vi.clearAllMocks();
});

describe('AgentAssistantPanel runtime failure', () => {
    it('shows the Codex failure and lets the user refresh without offering sign-in', () => {
        const host = mountPanel();

        expect(host.querySelector('h2')?.textContent).toBe('assistant.runtimeErrorTitle');
        expect(host.querySelector('.agent-assistant-error')?.textContent).toContain('invalid transport');
        const refresh = [...host.querySelectorAll('button')]
            .find(button => button.textContent === 'assistant.refresh');
        expect(refresh).toBeDefined();

        refresh!.click();

        expect(mocks.handleRefreshState).toHaveBeenCalledOnce();
        expect(host.textContent).not.toContain('assistant.signInChatGpt');
    });
});
