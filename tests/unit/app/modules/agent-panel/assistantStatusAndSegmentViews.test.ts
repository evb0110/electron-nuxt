// @vitest-environment happy-dom

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
} from 'vue';
import AssistantMessageSegments from '@app/modules/agent-panel/components/AssistantMessageSegments.vue';
import AssistantTurnStatus from '@app/modules/agent-panel/components/AssistantTurnStatus.vue';

// `tests/setup.ts` translates to the key itself (with parameters appended) and
// throws on a key the English schema does not define, so these assertions read
// as message identity and also fail if a key is ever dropped from the schema.

/**
 * Both components render fragments, so the panel's scoped stylesheet cannot
 * reach their nodes and each has to carry its own styles. These mounts pin the
 * markup those styles are written against: a class that moves here without its
 * rule, or a rule that stays behind in the panel, shows up as a status line or
 * inline code span rendered at the browser's default type size.
 */
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

const ButtonStub = defineComponent({
    props: {label: {
        type: String,
        default: '',
    }},
    setup: (props, {attrs}) => () => h('button', {
        ...attrs,
        type: 'button',
    }, props.label),
});

const activeUnmounts = new Set<() => void>();

function mount(component: unknown, props: Record<string, unknown>) {
    const host = document.createElement('div');
    document.body.append(host);
    const app = createApp(component as Parameters<typeof createApp>[0], props);
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
});

describe('AssistantTurnStatus', () => {
    it('renders the turn pill, tool activity, reasoning, and usage on the classes it styles', () => {
        const host = mount(AssistantTurnStatus, {
            active: true,
            canRetry: true,
            reasoning: 'weighing the page range',
            stalled: true,
            statusText: 'Working - 3s ago',
            tools: [{
                name: 'set_page_labels',
                phase: 'running',
                toolId: 'tool-1',
            }],
            usage: {
                inputTokens: 12,
                outputTokens: 34,
            },
        });

        const progress = host.querySelector('.agent-assistant-turn-progress');
        expect(progress?.textContent).toContain('Working - 3s ago');
        expect(progress?.querySelector('.agent-assistant-working-icon.is-spinning')).not.toBeNull();
        expect(host.querySelector('.agent-assistant-reasoning pre')?.textContent)
            .toBe('weighing the page range');
        expect(host.querySelector('.agent-assistant-reasoning summary')?.textContent)
            .toBe('assistant.thinking');
        const activity = [...host.querySelectorAll('.agent-assistant-tool-activity')];
        expect(activity).toHaveLength(2);
        expect(activity[0]?.textContent).toContain(
            'assistant.toolActivity:{"name":"set_page_labels","phase":"assistant.toolPhaseRunning"}',
        );
        expect(activity[1]?.textContent).toContain(
            'assistant.turnUsage:{"input":12,"output":34}',
        );
        expect(host.querySelector('.agent-assistant-turn-error')?.textContent)
            .toBe('assistant.turnStalled');
        expect(host.querySelector('button')?.textContent).toBe('assistant.turnRetry');
    });

    it('renders nothing for an idle turn with no activity', () => {
        const host = mount(AssistantTurnStatus, {
            active: false,
            canRetry: false,
            reasoning: '',
            stalled: false,
            statusText: '',
            tools: [],
            usage: null,
        });

        expect(host.textContent).toBe('');
    });
});

describe('AssistantMessageSegments', () => {
    it('renders each segment kind on the class its own stylesheet targets', () => {
        const host = mount(AssistantMessageSegments, {segments: [
            {
                kind: 'text',
                text: 'label ',
            },
            {
                kind: 'code',
                text: 'Copyright',
            },
            {
                kind: 'strong',
                text: 'saved',
            },
            {
                kind: 'emphasis',
                text: 'again',
            },
            {
                href: 'https://example.com/doc',
                kind: 'link',
                text: 'source',
            },
        ]});

        expect(host.querySelector('code.agent-assistant-message-inline-code')?.textContent)
            .toBe('Copyright');
        expect(host.querySelector('strong.agent-assistant-message-strong')?.textContent)
            .toBe('saved');
        expect(host.querySelector('em.agent-assistant-message-emphasis')?.textContent)
            .toBe('again');
        const link = host.querySelector<HTMLAnchorElement>('a.agent-assistant-message-link');
        expect(link?.getAttribute('href')).toBe('https://example.com/doc');
        expect(link?.getAttribute('rel')).toBe('noopener noreferrer');
        expect(host.textContent).toContain('label ');
    });
});
