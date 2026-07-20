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
    h,
    nextTick,
} from 'vue';
import type {IDocumentPageSource} from '@app/utils/document-viewer/source/documentPageSource';
import DocumentThumbnailList from '@app/components/document-viewer/DocumentThumbnailList.vue';

vi.mock('@app/composables/useTypedI18n', () => ({useTypedI18n: () => ({t: (key: string) => key})}));

class ResizeObserverStub implements ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
}

const originalResizeObserver = globalThis.ResizeObserver;
const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;

afterEach(() => {
    globalThis.ResizeObserver = originalResizeObserver;
    globalThis.requestAnimationFrame = originalRequestAnimationFrame;
    globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
    vi.restoreAllMocks();
    document.body.innerHTML = '';
});

describe('DocumentThumbnailList virtualization', () => {
    it('keeps a 500-page source to a bounded mounted row count', async () => {
        globalThis.ResizeObserver = ResizeObserverStub;
        globalThis.requestAnimationFrame = callback => window.setTimeout(() => callback(performance.now()), 0);
        globalThis.cancelAnimationFrame = handle => window.clearTimeout(handle);
        vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(220);
        vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600);
        vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
            bottom: 150,
            height: 140,
            left: 0,
            right: 180,
            top: 10,
            width: 180,
            x: 0,
            y: 10,
            toJSON: () => ({}),
        });
        const renderPage = vi.fn(async () => ({
            widthPx: 180,
            heightPx: 252,
            bytes: 181_440,
            surface: document.createElement('canvas'),
            release: vi.fn(),
        }));
        const source: IDocumentPageSource = {
            kind: 'pdf',
            documentRef: '/large.pdf',
            pageCount: 500,
            getPageMetrics: vi.fn(async () => ({
                widthPoints: 500,
                heightPoints: 700,
                rotation: 0 as const,
            })),
            renderPage,
            thumbnailProvider: {renderThumbnail: renderPage},
            dispose: vi.fn(),
        };
        const host = document.createElement('div');
        document.body.append(host);
        const app = createApp({render: () => h(DocumentThumbnailList, {
            source,
            currentPage: 1,
        })});
        app.mount(host);
        await nextTick();
        await new Promise(resolve => setTimeout(resolve, 20));
        await nextTick();

        const rows = host.querySelectorAll('[data-document-thumbnail-item]');
        expect(rows.length).toBeGreaterThan(0);
        expect(rows.length).toBeLessThan(30);
        expect(host.querySelectorAll('[data-thumbnail-page]').length).toBe(rows.length);

        app.unmount();
        host.remove();
    });
});
