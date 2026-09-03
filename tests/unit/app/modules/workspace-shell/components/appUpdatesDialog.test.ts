// @vitest-environment happy-dom

import {
    createApp,
    defineComponent,
    h,
} from 'vue';
import {
    afterEach,
    describe,
    expect,
    it,
    onTestFinished,
    vi,
} from 'vitest';
import AppUpdatesDialog from '@app/modules/workspace-shell/components/AppUpdatesDialog.vue';

const UModal = defineComponent({
    props: {
        open: Boolean,
        title: String,
    },
    emits: ['update:open'],
    setup(props, {
        emit,
        slots,
    }) {
        return () => h('section', {class: 'modal-stub'}, [
            h('h1', props.title),
            h('button', {
                class: 'close-modal',
                onClick: () => emit('update:open', false),
            }, 'Close modal'),
            slots.body?.(),
            slots.footer?.({close: () => emit('update:open', false)}),
        ]);
    },
});

const UButton = defineComponent({
    props: {label: String},
    emits: ['click'],
    setup(props, {emit}) {
        return () => h('button', {onClick: () => emit('click')}, props.label);
    },
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('AppUpdatesDialog', () => {
    it('renders update actions and forwards each dialog event', () => {
        vi.stubGlobal('useTypedI18n', () => ({t: (key: string) => key}));
        const events = {
            close: vi.fn(),
            defer: vi.fn(),
            download: vi.fn(),
            skip: vi.fn(),
            install: vi.fn(),
        };
        const host = document.createElement('div');
        document.body.append(host);
        const app = createApp(AppUpdatesDialog, {
            open: true,
            title: 'Update available',
            description: 'Version 2.0.0 is ready.',
            progressPercent: null,
            available: true,
            ready: false,
            failure: null,
            'onUpdate:open': events.close,
            onDefer: events.defer,
            onDownload: events.download,
            onSkip: events.skip,
            onInstall: events.install,
        });
        app.component('UModal', UModal);
        app.component('UButton', UButton);
        app.mount(host);
        onTestFinished(() => {
            app.unmount();
            host.remove();
        });

        expect(host.querySelector('h1')?.textContent).toBe('Update available');
        expect(host.textContent).toContain('Version 2.0.0 is ready.');
        const buttons = [...host.querySelectorAll('button')];
        const click = (label: string) => buttons.find(button => button.textContent === label)?.click();

        click('updates.deferAction');
        click('updates.skipAction');
        click('updates.downloadAction');
        click('Close modal');

        expect(events.defer).toHaveBeenCalledOnce();
        expect(events.skip).toHaveBeenCalledOnce();
        expect(events.download).toHaveBeenCalledOnce();
        expect(events.install).not.toHaveBeenCalled();
        expect(events.close).toHaveBeenCalledWith(false);
    });
});
