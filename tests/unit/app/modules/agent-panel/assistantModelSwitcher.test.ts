// @vitest-environment happy-dom

import type {
    IAgentAssistantProviderStatus,
    TAgentAssistantProviderId,
} from '@contracts/agent';
import {
    afterEach,
    describe,
    expect,
    it,
} from 'vitest';
import {
    createApp,
    defineComponent,
    h,
    nextTick,
    reactive,
} from 'vue';
import AssistantModelSwitcher from '@app/modules/agent-panel/components/AssistantModelSwitcher.vue';
import { createAgentAssistantStatus } from '@tests/helpers/createAgentAssistantStatus';

/**
 * The picker's whole job is to say, without prose, which assistant is talking
 * and which model it will use. These mounts pin the three signals that carry
 * that: the provider tab marked selected, the model row marked checked, and the
 * recommended badge on whichever model the provider reports as its default.
 */
const { providers } = createAgentAssistantStatus();

const IconStub = defineComponent({
    props: {name: {
        type: String,
        default: '',
    }},
    setup: (props, {attrs}) => () => h('i', {
        ...attrs,
        'data-icon': props.name,
    }),
});

const PopoverStub = defineComponent({
    props: {
        content: {
            type: Object,
            default: () => ({}),
        },
        mode: {
            type: String,
            default: '',
        },
        open: {
            type: Boolean,
            default: false,
        },
        portal: {
            type: String,
            default: '',
        },
    },
    emits: ['update:open'],
    setup: (_props, {slots}) => () => h('div', [
        slots.default?.(),
        slots.content?.(),
    ]),
});

interface IHarnessState {
    providers: readonly IAgentAssistantProviderStatus[];
    selectedProvider: TAgentAssistantProviderId;
    selectedModel: string;
    isSwitching?: boolean;
    disabled?: boolean;
}

const activeUnmounts = new Set<() => void>();

/**
 * The switcher is controlled: it reports a click and waits for the parent to
 * hand back new props. The harness mirrors that, so switching provider really
 * does re-render the model list instead of leaving the previous one on screen.
 */
function mountSwitcher(overrides: Partial<IHarnessState> = {}) {
    const events: Record<string, unknown[]> = {
        'select-model': [],
        'select-provider': [],
    };
    const state = reactive<IHarnessState>({
        providers,
        selectedProvider: 'codex',
        selectedModel: 'gpt-5.6-sol',
        ...overrides,
    });
    const host = document.createElement('div');
    document.body.append(host);
    const app = createApp(defineComponent({setup: () => () => h(AssistantModelSwitcher, {
        ...state,
        'onSelect-model': (model: string) => {
            events['select-model']!.push(model);
            state.selectedModel = model;
        },
        'onSelect-provider': (provider: TAgentAssistantProviderId) => {
            events['select-provider']!.push(provider);
            state.selectedProvider = provider;
        },
    })}));
    app.component('UIcon', IconStub);
    app.component('UPopover', PopoverStub);
    app.mount(host);
    const unmount = () => {
        app.unmount();
        host.remove();
        activeUnmounts.delete(unmount);
    };
    activeUnmounts.add(unmount);
    return {
        events,
        host,
    };
}

function textOf(element: Element | null) {
    return element?.textContent?.trim() ?? '';
}

afterEach(() => {
    for (const unmount of [...activeUnmounts]) {
        unmount();
    }
});

describe('AssistantModelSwitcher', () => {
    it('marks the selected provider, the selected model, and the recommended default', () => {
        const { host } = mountSwitcher();

        const tabs = [...host.querySelectorAll('.assistant-model-provider')];
        expect(tabs.map(tab => textOf(tab))).toEqual([
            'Codex',
            'Claude',
        ]);
        expect(tabs.map(tab => tab.getAttribute('aria-selected'))).toEqual([
            'true',
            'false',
        ]);

        const options = [...host.querySelectorAll('.assistant-switcher-option')];
        expect(options.map(option => textOf(option.querySelector('.assistant-switcher-option-label'))))
            .toEqual([
                'default',
                'GPT-5.6-Sol',
            ]);
        expect(options.map(option => option.getAttribute('aria-checked'))).toEqual([
            'false',
            'true',
        ]);
        expect(options[1]?.querySelector('[data-icon="i-ph-check"]')).not.toBeNull();

        const recommended = [...host.querySelectorAll('.assistant-model-recommended')];
        expect(recommended).toHaveLength(1);
        expect(textOf(options[0]!.querySelector('.assistant-model-recommended')))
            .toBe('assistant.modelRecommended');
        expect(textOf(host.querySelector('.assistant-switcher-hint')))
            .toBe('assistant.modelPickerHint');
    });

    it('shows the active model on the trigger without repeating the provider name', () => {
        const { host } = mountSwitcher({
            selectedModel: 'default',
            selectedProvider: 'claude',
        });

        expect(textOf(host.querySelector('.assistant-switcher-trigger-value'))).toBe('default');
        expect(host.querySelector('.assistant-switcher-trigger')?.getAttribute('aria-label'))
            .toBe('assistant.provider: Claude. assistant.model: Claude default');
    });

    it('swaps the model list when the user picks the other provider', async () => {
        const {
            events,
            host,
        } = mountSwitcher();

        host.querySelectorAll('.assistant-model-provider')[1]?.dispatchEvent(new MouseEvent('click'));
        await nextTick();

        const tabs = [...host.querySelectorAll('.assistant-model-provider')];
        expect(tabs.map(tab => tab.getAttribute('aria-selected'))).toEqual([
            'false',
            'true',
        ]);

        const options = [...host.querySelectorAll('.assistant-switcher-option')];
        expect(options.map(option => textOf(option.querySelector('.assistant-switcher-option-label'))))
            .toEqual(['default']);

        options[0]?.dispatchEvent(new MouseEvent('click'));

        expect(events['select-provider']).toEqual(['claude']);
        expect(events['select-model']).toEqual(['default']);
    });

    it('stays inert while a turn owns the selection', () => {
        const {
            events,
            host,
        } = mountSwitcher({disabled: true});

        host.querySelectorAll('.assistant-model-provider')[1]?.dispatchEvent(new MouseEvent('click'));
        host.querySelectorAll('.assistant-switcher-option')[0]?.dispatchEvent(new MouseEvent('click'));

        expect(events['select-provider']).toEqual([]);
        expect(events['select-model']).toEqual([]);
        expect(host.querySelector('.assistant-switcher-trigger')?.hasAttribute('disabled')).toBe(true);
    });
});
