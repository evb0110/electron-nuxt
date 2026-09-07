// @vitest-environment happy-dom

import {
    createApp,
    defineComponent,
    h,
} from 'vue';
import {
    describe,
    expect,
    it,
    onTestFinished,
    vi,
} from 'vitest';
import type {FailureReceipt} from '@contracts/diagnostics/failureReceipt';
import AppFailureAlert from '@app/components/AppFailureAlert.vue';

const failure = {
    eventId: '0123456789abcdef0123456789abcdef',
    code: 'UNCLASSIFIED_RENDERER_ERROR',
    occurredAt: 1,
    severity: 'error',
} as FailureReceipt;

describe('AppFailureAlert', () => {
    it('renders an existing receipt without creating a second owner', async () => {
        const writeText = vi.fn().mockResolvedValue(undefined);
        vi.stubGlobal('navigator', {clipboard: {writeText}});
        const received = vi.fn();
        const UAlert = defineComponent({
            inheritAttrs: false,
            setup(_props, {
                attrs,
                slots,
            }) {
                received(attrs);
                return () => h('div', [
                    String(attrs.description),
                    slots.description?.(),
                ]);
            },
        });
        const host = document.createElement('div');
        document.body.append(host);
        const app = createApp(AppFailureAlert, {presentation: {
            failure,
            title: 'Combine failed',
            description: 'The PDF could not be combined.',
        }});
        app.component('UAlert', UAlert);
        app.mount(host);
        onTestFinished(() => {
            app.unmount();
            host.remove();
            vi.unstubAllGlobals();
        });

        expect(host.textContent).toContain('Error ID: 01234567');
        expect(received).toHaveBeenCalledOnce();
        expect(received.mock.calls[0]?.[0]).toMatchObject({color: 'error'});
    });

    it('keeps technical open details behind an accessible disclosure', async () => {
        const UAlert = defineComponent({
            inheritAttrs: false,
            setup(_props, {slots}) {
                return () => h('div', slots.description?.());
            },
        });
        const host = document.createElement('div');
        document.body.append(host);
        const app = createApp(AppFailureAlert, {presentation: {
            failure,
            title: 'Failed to open file',
            description: 'The PDF viewer needs its development dependencies synchronized before this file can open.',
            technicalDetails: 'PDF.js vendored asset version mismatch at /pdf/.pdfjs-version: installed runtime is 5.7.284, vendored assets are 6.3.311',
        }});
        app.component('UAlert', UAlert);
        app.mount(host);
        onTestFinished(() => {
            app.unmount();
            host.remove();
        });

        const disclosure = host.querySelector('details');
        expect(disclosure).not.toBeNull();
        expect(disclosure?.textContent).toContain('errors.runtime.details');
        expect(disclosure?.textContent).toContain('installed runtime is 5.7.284');
        expect(disclosure?.textContent).toContain('Error ID: 0123456789abcdef0123456789abcdef');
    });
});
