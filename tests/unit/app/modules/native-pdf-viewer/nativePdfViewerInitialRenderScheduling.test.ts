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
    ref,
} from 'vue';
import NativePdfPageContent from '@app/modules/native-pdf-viewer/components/NativePdfPageContent.vue';
import { resolveNativePdfRenderQueue } from '@app/modules/native-pdf-viewer/runtime/resolveNativePdfRenderQueue';
import type { IDocumentPreviewPageState } from '@app/utils/document-viewer/pagePreviewSource';

vi.mock('@app/composables/useTypedI18n', () => ({useTypedI18n: () => ({t: (key: string) => key})}));

const activeUnmounts = new Set<() => void>();

function mountPageContent(onVisualReady: (pageNumber: number) => void) {
    const host = document.createElement('div');
    document.body.append(host);
    const pageState = ref<IDocumentPreviewPageState>({
        failedRenderPx: 0,
        objectUrl: 'blob:page-3',
        renderedPx: 900,
        status: 'loaded',
        token: 1,
    });
    const TestHost = defineComponent({setup: () => () => h(NativePdfPageContent, {
        pageNumber: 3,
        pageState: pageState.value,
        visualCommitted: false,
        onVisualReady: (payload: {pageNumber: number}) => onVisualReady(payload.pageNumber),
    })});
    const app = createApp(TestHost);
    const ElementStub = defineComponent({setup: () => () => h('span')});
    app.component('UButton', ElementStub);
    app.component('UIcon', ElementStub);
    app.component('USkeleton', ElementStub);
    app.mount(host);
    const unmount = () => {
        app.unmount();
        host.remove();
        activeUnmounts.delete(unmount);
    };
    activeUnmounts.add(unmount);
    return {
        host,
        unmount,
    };
}

afterEach(() => {
    for (const unmount of activeUnmounts) unmount();
    activeUnmounts.clear();
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
});

describe('Native PDF viewer initial render scheduling', () => {
    it('keeps cold-open demand on the restored page, then restores distance ordering', () => {
        const activePages = new Set([
            1,
            2,
            3,
            4,
            5,
        ]);

        expect(resolveNativePdfRenderQueue({
            activePage: 3,
            activePages,
            deferAdjacentPages: true,
        })).toEqual([3]);
        expect(resolveNativePdfRenderQueue({
            activePage: 3,
            activePages,
            deferAdjacentPages: false,
        })).toEqual([
            3,
            2,
            4,
            1,
            5,
        ]);
    });

    it('reports the restored image ready only after it crosses two paint frames', async () => {
        const frames: FrameRequestCallback[] = [];
        vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
            frames.push(callback);
            return frames.length;
        });
        const readyPages: number[] = [];
        const harness = mountPageContent(pageNumber => readyPages.push(pageNumber));
        const initialImage = harness.host.querySelector<HTMLImageElement>('.native-pdf-page-image');
        expect(initialImage).not.toBeNull();
        initialImage?.dispatchEvent(new Event('load'));
        await Promise.resolve();

        expect(frames).toHaveLength(1);
        frames.shift()?.(0);
        await Promise.resolve();
        expect(readyPages).toEqual([]);

        expect(frames).toHaveLength(1);
        frames.shift()?.(16);
        await vi.waitFor(() => expect(readyPages).toEqual([3]));

        harness.unmount();
    });
});
