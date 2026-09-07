// @vitest-environment happy-dom

import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    onTestFinished,
    vi,
} from 'vitest';
import {
    createApp,
    defineComponent,
    h,
    nextTick,
    ref,
} from 'vue';
import type {FailureReceipt} from '@contracts/diagnostics/failureReceipt';
import {requireEpochMs} from '@contracts/timestamps';

const toastAdd = vi.fn();

function installUseToastStub() {
    vi.stubGlobal('useToast', () => ({add: toastAdd}));
}

function createFailure(): FailureReceipt {
    return {
        eventId: '0123456789abcdef0123456789abcdef' as FailureReceipt['eventId'],
        code: 'UNCLASSIFIED_RENDERER_ERROR',
        occurredAt: requireEpochMs(1767225600000),
        severity: 'error',
    };
}

async function loadFailureToast() {
    return import('@app/composables/useFailureToast');
}

describe('useFailureToast', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        installUseToastStub();
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('presents one short Error ID and keeps the full receipt local to copy', async () => {
        const {
            formatFailurePresentationCopy,
            useFailureToast,
        } = await loadFailureToast();
        const {presentFailureToast} = useFailureToast();
        const failure = createFailure();
        const presentation = {
            failure,
            title: 'Renderer failure',
            description: 'The document could not be opened.',
        };

        presentFailureToast(presentation);

        const toast = toastAdd.mock.calls[0]?.[0];
        expect(toast).toMatchObject({
            color: 'error',
            title: 'Renderer failure',
            description: 'The document could not be opened.\nError ID: 01234567',
        });
        expect(toast.description).not.toContain(failure.eventId);
        expect(toast.description).not.toContain('Sentry report received');
        expect(formatFailurePresentationCopy(presentation)).toBe([
            `Error ID: ${failure.eventId}`,
            'Renderer failure',
            'The document could not be opened.',
        ].join('\n'));
    });

    it('copies the full ID and local details without capturing', async () => {
        const writeText = vi.fn().mockResolvedValue(undefined);
        vi.stubGlobal('navigator', {clipboard: {writeText}});
        const {
            copyFailurePresentation,
            useFailureToast,
        } = await loadFailureToast();
        const failure = createFailure();
        const presentation = {
            failure,
            title: 'Renderer failure',
            description: 'The document could not be opened.',
        };

        expect(await copyFailurePresentation(presentation)).toBe(true);
        expect(writeText).toHaveBeenCalledWith([
            `Error ID: ${failure.eventId}`,
            'Renderer failure',
            'The document could not be opened.',
        ].join('\n'));
        expect(useFailureToast().copyFailurePresentation).toBe(copyFailurePresentation);
    });

    it('keeps technical details in Copy details instead of the short toast text', async () => {
        const writeText = vi.fn().mockResolvedValue(undefined);
        vi.stubGlobal('navigator', {clipboard: {writeText}});
        const {
            formatFailurePresentationCopy,
            useFailureToast,
        } = await loadFailureToast();
        const presentation = {
            failure: createFailure(),
            title: 'Failed to open file',
            description: 'The PDF viewer needs synchronized development dependencies.',
            technicalDetails: 'PDF.js vendored asset version mismatch at /pdf/.pdfjs-version',
        };

        useFailureToast().presentFailureToast(presentation);

        expect(toastAdd.mock.calls[0]?.[0].description).toBe('The PDF viewer needs synchronized development dependencies.\nError ID: 01234567');
        expect(formatFailurePresentationCopy(presentation)).toContain(presentation.technicalDetails);
    });

    it('preserves custom presentation actions for shared callers', async () => {
        const {useFailureToast} = await loadFailureToast();
        const {presentFailureToast} = useFailureToast();
        const actions = [{
            label: 'Details',
            onClick: vi.fn(),
        }];

        presentFailureToast({
            failure: createFailure(),
            title: 'Renderer failure',
            actions,
        });

        expect(toastAdd.mock.calls[0]?.[0].actions).toBe(actions);
    });

    it('does not create another toast when the presenter owner rerenders', async () => {
        const {useFailureToast} = await loadFailureToast();
        const failure = createFailure();
        const revision = ref(0);
        const host = document.createElement('div');
        document.body.append(host);
        const app = createApp(defineComponent({setup: () => {
            useFailureToast().presentFailureToast({
                failure,
                title: 'Renderer failure',
            });
            return () => h('span', revision.value);
        }}));

        app.mount(host);
        onTestFinished(() => {
            app.unmount();
            host.remove();
        });
        revision.value += 1;
        await nextTick();

        expect(toastAdd).toHaveBeenCalledOnce();
    });
});
