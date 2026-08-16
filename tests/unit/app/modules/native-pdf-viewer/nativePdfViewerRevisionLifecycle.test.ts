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
    nextTick,
    provide,
    ref,
} from 'vue';
import { requireDocumentRevisionToken } from '@contracts/documentRevision';
import type {
    IPagePreviewRenderedObjectUrl,
    IPagePreviewSource,
} from '@app/utils/document-viewer/pagePreviewSource';
import NativePdfViewer from '@app/modules/native-pdf-viewer/components/NativePdfViewer.vue';
import { useDocumentOpenVisualSettle } from '@app/modules/workspace-shell/composables/useDocumentOpenVisualSettle';
import {
    createDocumentViewerChassisAuthority,
    documentViewerChassisAuthorityKey,
} from '@app/utils/document-viewer/chassis/documentViewerChassisAuthority';

const nativePdfMocks = vi.hoisted(() => ({createSource: vi.fn()}));
const vueUseMocks = vi.hoisted(() => ({pixelRatio: undefined as ReturnType<typeof ref<number>> | undefined}));

vi.mock('@app/platform/browser-api/public', () => ({createNativePdfPreviewSourceFromPath: nativePdfMocks.createSource}));

vi.mock('@app/utils/platformDocuments', () => ({getDocumentFilesCapability: () => ({})}));

vi.mock('@vueuse/core', () => ({
    useDevicePixelRatio: () => ({pixelRatio: vueUseMocks.pixelRatio ??= ref(1)}),
    useResizeObserver: vi.fn(),
}));

vi.mock('@app/composables/useTypedI18n', () => ({useTypedI18n: () => ({t: (key: string) => key})}));

interface IViewerExpose {waitForViewerLoadSettled(): Promise<void>;}

interface ITestSource extends IPagePreviewSource {
    renderPageObjectUrl: ReturnType<typeof vi.fn<IPagePreviewSource['renderPageObjectUrl']>>;
    revokeObjectURL: ReturnType<typeof vi.fn<IPagePreviewSource['revokeObjectURL']>>;
    terminate: ReturnType<typeof vi.fn<IPagePreviewSource['terminate']>>;
}

interface IEvictableTestSource extends ITestSource {
    evictedObjectUrls: string[];
    evictPage(pageNumber: number, beforeObjectUrlRevocation?: () => void): void;
    resolveCurrentPageReplacement(): void;
}

const activeUnmounts = new Set<() => void>();

function createSource(
    revision: string,
    pageSizes: Array<{
        width: number;
        height: number
    }>,
    rasterWidthCeilingPx?: number,
): ITestSource {
    return {
        getPageSizes: vi.fn(async () => pageSizes),
        renderPageObjectUrl: vi.fn<IPagePreviewSource['renderPageObjectUrl']>(async pageNumber => ({
            objectUrl: `blob:${revision}:page-${String(pageNumber)}`,
            renderedPx: 768,
            ...(rasterWidthCeilingPx === undefined ? {} : {rasterWidthCeilingPx}),
        })),
        revokeObjectURL: vi.fn<IPagePreviewSource['revokeObjectURL']>(),
        terminate: vi.fn<IPagePreviewSource['terminate']>(),
    };
}

function createEvictableSource(): IEvictableTestSource {
    const evictedObjectUrls: string[] = [];
    const invalidationListeners = new Map<number, () => void>();
    const renderCounts = new Map<number, number>();
    const currentPageReplacement = Promise.withResolvers<IPagePreviewRenderedObjectUrl>();
    const renderPageObjectUrl = vi.fn<IPagePreviewSource['renderPageObjectUrl']>(async pageNumber => {
        const renderCount = (renderCounts.get(pageNumber) ?? 0) + 1;
        renderCounts.set(pageNumber, renderCount);
        if (pageNumber === 1 && renderCount === 2) {
            return currentPageReplacement.promise;
        }
        const objectUrl = `blob:eviction:page-${String(pageNumber)}:render-${String(renderCount)}`;
        return {
            objectUrl,
            renderedPx: 768,
            onInvalidated(listener) {
                invalidationListeners.set(pageNumber, listener);
                return () => {
                    if (invalidationListeners.get(pageNumber) === listener) {
                        invalidationListeners.delete(pageNumber);
                    }
                };
            },
        };
    });
    return {
        evictedObjectUrls,
        getPageSizes: vi.fn(async () => [
            {
                width: 400,
                height: 800,
            },
            {
                width: 400,
                height: 800,
            },
        ]),
        renderPageObjectUrl,
        revokeObjectURL: vi.fn<IPagePreviewSource['revokeObjectURL']>(),
        terminate: vi.fn<IPagePreviewSource['terminate']>(),
        evictPage(pageNumber, beforeObjectUrlRevocation) {
            const evictedObjectUrl = `blob:eviction:page-${String(pageNumber)}:render-${String(renderCounts.get(pageNumber) ?? 0)}`;
            const listener = invalidationListeners.get(pageNumber);
            invalidationListeners.delete(pageNumber);
            listener?.();
            beforeObjectUrlRevocation?.();
            evictedObjectUrls.push(evictedObjectUrl);
        },
        resolveCurrentPageReplacement() {
            currentPageReplacement.resolve({
                objectUrl: 'blob:eviction:page-1:render-2',
                renderedPx: 768,
                onInvalidated(listener) {
                    invalidationListeners.set(1, listener);
                    return () => {
                        if (invalidationListeners.get(1) === listener) {
                            invalidationListeners.delete(1);
                        }
                    };
                },
            });
        },
    };
}

async function settlePendingWork() {
    for (let index = 0; index < 5; index += 1) {
        await nextTick();
        await vi.advanceTimersByTimeAsync(0);
    }
}

async function settleImagePaint(image: HTMLImageElement) {
    image.dispatchEvent(new Event('load'));
    await vi.advanceTimersByTimeAsync(0);
    vi.advanceTimersToNextFrame();
    await vi.advanceTimersByTimeAsync(0);
    vi.advanceTimersToNextFrame();
    await vi.advanceTimersByTimeAsync(0);
}

function requireElement<TElement extends Element>(host: Element, selector: string) {
    const element = host.querySelector<TElement>(selector);
    if (!element) {
        throw new Error(`Expected element matching ${selector}`);
    }
    return element;
}

function requireViewer(viewer: IViewerExpose | null) {
    if (!viewer) {
        throw new Error('Expected the native PDF viewer expose');
    }
    return viewer;
}

afterEach(() => {
    for (const unmount of activeUnmounts) unmount();
    activeUnmounts.clear();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    if (vueUseMocks.pixelRatio) vueUseMocks.pixelRatio.value = 1;
    document.body.innerHTML = '';
});

describe('NativePdfViewer revision lifecycle', () => {
    it('fails an empty native PDF immediately instead of waiting for the host timeout', async () => {
        vi.useFakeTimers();
        const documentPath = '/managed/empty.pdf';
        const source = createSource('empty', []);
        nativePdfMocks.createSource.mockReturnValue(source);
        const host = document.createElement('div');
        const viewport = document.createElement('div');
        document.body.append(host, viewport);
        Object.defineProperties(viewport, {
            clientHeight: {
                configurable: true,
                value: 600,
            },
            clientWidth: {
                configurable: true,
                value: 800,
            },
        });
        const viewer = ref<IViewerExpose | null>(null);
        const loadErrors: unknown[] = [];
        const authority = createDocumentViewerChassisAuthority(ref('pdf'));
        authority.bindViewportElement(viewport);
        authority.openSurface.begin({
            documentId: documentPath,
            documentRevision: 'drt1:test:empty',
        });
        const Root = defineComponent({setup() {
            provide(documentViewerChassisAuthorityKey, authority);
            return () => h(NativePdfViewer, {
                ref: viewer,
                src: documentPath,
                isActive: true,
                currentPage: 1,
                onLoadError: (error: unknown) => loadErrors.push(error),
            });
        }});
        const app = createApp(Root);
        const ElementStub = defineComponent({setup: () => () => h('span')});
        app.component('UButton', ElementStub);
        app.component('UIcon', ElementStub);
        app.component('USkeleton', ElementStub);
        app.mount(host);
        const unmount = () => {
            app.unmount();
            host.remove();
            viewport.remove();
            activeUnmounts.delete(unmount);
        };
        activeUnmounts.add(unmount);

        await settlePendingWork();
        await expect(requireViewer(viewer.value).waitForViewerLoadSettled()).resolves.toBeUndefined();
        expect(loadErrors).toHaveLength(1);
        expect(loadErrors[0]).toEqual(expect.objectContaining({message: 'PDF contains no pages'}));
        expect(source.terminate).toHaveBeenCalledOnce();
        expect(authority.openSurface.snapshot.value).toMatchObject({
            phase: 'failed',
            presentation: 'failed',
            failure: 'PDF contains no pages',
        });
        expect(host.querySelector('[data-testid="native-pdf-viewer-error"]')?.textContent)
            .toContain('PDF contains no pages');
    });

    it('fully reloads a same-path document when its revision changes', async () => {
        vi.useFakeTimers();
        class PreloadImage {
            onload: (() => void) | null = null;
            onerror: (() => void) | null = null;

            set src(_value: string) {
                queueMicrotask(() => this.onload?.());
            }
        }
        vi.stubGlobal('Image', PreloadImage);

        const firstRevision = requireDocumentRevisionToken('drt1:test:native-r1');
        const secondRevision = requireDocumentRevisionToken('drt1:test:native-r2');
        const documentPath = '/managed/reloaded-in-place.pdf';
        const firstSource = createSource('r1', [
            {
                width: 400,
                height: 800,
            },
            {
                width: 500,
                height: 700,
            },
        ], 4_096);
        const secondSource = createSource('r2', [
            {
                width: 800,
                height: 400,
            },
            {
                width: 600,
                height: 600,
            },
            {
                width: 400,
                height: 800,
            },
        ]);
        nativePdfMocks.createSource
            .mockReturnValueOnce(firstSource)
            .mockReturnValueOnce(secondSource);

        const host = document.createElement('div');
        const viewport = document.createElement('div');
        document.body.append(host, viewport);
        Object.defineProperties(viewport, {
            clientHeight: {
                configurable: true,
                value: 600,
            },
            clientWidth: {
                configurable: true,
                value: 800,
            },
        });
        const revision = ref(firstRevision);
        const viewer = ref<IViewerExpose | null>(null);
        const totalPageUpdates: number[] = [];
        const authority = createDocumentViewerChassisAuthority(ref('pdf'));
        authority.bindViewportElement(viewport);
        authority.openSurface.begin({
            documentId: documentPath,
            documentRevision: firstRevision,
        });
        const commitCanvas = vi.spyOn(authority.openSurface, 'commitCanvas');
        const Root = defineComponent({setup() {
            provide(documentViewerChassisAuthorityKey, authority);
            return () => h(NativePdfViewer, {
                ref: viewer,
                src: documentPath,
                documentRevisionToken: revision.value,
                isActive: true,
                currentPage: 1,
                'onUpdate:totalPages': (pageCount: number) => totalPageUpdates.push(pageCount),
            });
        }});
        const app = createApp(Root);
        const ElementStub = defineComponent({setup: () => () => h('span')});
        app.component('UButton', ElementStub);
        app.component('UIcon', ElementStub);
        app.component('USkeleton', ElementStub);
        app.mount(host);
        const unmount = () => {
            app.unmount();
            host.remove();
            viewport.remove();
            activeUnmounts.delete(unmount);
        };
        activeUnmounts.add(unmount);

        await settlePendingWork();
        const firstImage = requireElement<HTMLImageElement>(host, 'img[src="blob:r1:page-1"]');
        const firstPageStyle = requireElement<HTMLElement>(host, '[data-page-number="1"]')
            .getAttribute('style');
        await settleImagePaint(firstImage);
        await expect(requireViewer(viewer.value).waitForViewerLoadSettled()).resolves.toBeUndefined();
        expect(totalPageUpdates.at(-1)).toBe(2);
        expect(commitCanvas).toHaveBeenCalledTimes(1);

        authority.openSurface.begin({
            documentId: documentPath,
            documentRevision: secondRevision,
        });
        revision.value = secondRevision;
        await settlePendingWork();

        const secondSettle = requireViewer(viewer.value).waitForViewerLoadSettled();
        let secondSettled = false;
        void secondSettle.then(() => {
            secondSettled = true;
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(secondSettled).toBe(false);
        expect(firstSource.revokeObjectURL).toHaveBeenCalledWith('blob:r1:page-1');
        expect(firstSource.terminate).toHaveBeenCalledOnce();
        expect(totalPageUpdates).toContain(0);
        expect(totalPageUpdates.at(-1)).toBe(3);
        expect(requireElement(host, '[data-page-number="1"]').getAttribute('style')).not.toBe(firstPageStyle);

        const secondImage = requireElement<HTMLImageElement>(host, 'img[src="blob:r2:page-1"]');
        expect(secondSource.renderPageObjectUrl).toHaveBeenCalledWith(1, {targetWidthPx: 760});
        await settleImagePaint(secondImage);
        await secondSettle;
        expect(secondSettled).toBe(true);
        expect(commitCanvas).toHaveBeenCalledTimes(2);
        expect(host.querySelector('img[src^="blob:r1:"]')).toBeNull();
        expect(host.querySelector('img[src="blob:r2:page-1"]')).not.toBeNull();
    });

    it('retries an initial raster evicted before preload instead of failing the document', async () => {
        vi.useFakeTimers();
        class PreloadImage {
            onload: (() => void) | null = null;

            set src(_value: string) {
                queueMicrotask(() => this.onload?.());
            }
        }
        vi.stubGlobal('Image', PreloadImage);

        const documentPath = '/managed/initial-preload-eviction.pdf';
        const source = createSource('preload-eviction', [{
            width: 400,
            height: 800,
        }]);
        let renderCount = 0;
        source.renderPageObjectUrl.mockImplementation(async () => {
            renderCount += 1;
            const objectUrl = `blob:preload-eviction:render-${String(renderCount)}`;
            return {
                objectUrl,
                renderedPx: 768,
                ...(renderCount === 1
                    ? {onInvalidated(listener: () => void) {
                        queueMicrotask(listener);
                        return () => {};
                    }}
                    : {}),
            };
        });
        nativePdfMocks.createSource.mockReturnValue(source);
        const host = document.createElement('div');
        const viewport = document.createElement('div');
        document.body.append(host, viewport);
        Object.defineProperties(viewport, {
            clientHeight: {
                configurable: true,
                value: 600,
            },
            clientWidth: {
                configurable: true,
                value: 800,
            },
        });
        const viewer = ref<IViewerExpose | null>(null);
        const authority = createDocumentViewerChassisAuthority(ref('pdf'));
        authority.bindViewportElement(viewport);
        authority.openSurface.begin({
            documentId: documentPath,
            documentRevision: 'drt1:test:preload-eviction',
        });
        const Root = defineComponent({setup() {
            provide(documentViewerChassisAuthorityKey, authority);
            return () => h(NativePdfViewer, {
                ref: viewer,
                src: documentPath,
                isActive: true,
                currentPage: 1,
            });
        }});
        const app = createApp(Root);
        const ElementStub = defineComponent({setup: () => () => h('span')});
        app.component('UButton', ElementStub);
        app.component('UIcon', ElementStub);
        app.component('USkeleton', ElementStub);
        app.mount(host);
        const unmount = () => {
            app.unmount();
            host.remove();
            viewport.remove();
            activeUnmounts.delete(unmount);
        };
        activeUnmounts.add(unmount);

        await settlePendingWork();
        expect(source.renderPageObjectUrl).toHaveBeenCalledTimes(2);
        expect(source.revokeObjectURL).not.toHaveBeenCalledWith('blob:preload-eviction:render-1');
        expect(host.querySelector('[data-testid="native-pdf-viewer-error"]')).toBeNull();
        const replacementImage = requireElement<HTMLImageElement>(
            host,
            'img[src="blob:preload-eviction:render-2"]',
        );
        await settleImagePaint(replacementImage);
        await expect(requireViewer(viewer.value).waitForViewerLoadSettled()).resolves.toBeUndefined();
        expect(authority.openSurface.viewportSession.value.lifecycle).toBe('ready');
    });

    it('projects a mouse-scrolled page into the shared viewport authority', async () => {
        vi.useFakeTimers();
        class PreloadImage {
            onload: (() => void) | null = null;

            set src(_value: string) {
                queueMicrotask(() => this.onload?.());
            }
        }
        vi.stubGlobal('Image', PreloadImage);

        const documentPath = '/managed/mouse-scroll.pdf';
        const source = createSource('mouse-scroll', Array.from({length: 4}, () => ({
            width: 400,
            height: 800,
        })));
        source.renderPageObjectUrl.mockImplementation(async (pageNumber, options) => {
            const targetWidthPx = typeof options === 'object'
                && options !== null
                && 'targetWidthPx' in options
                && typeof options.targetWidthPx === 'number'
                ? options.targetWidthPx
                : 1;
            return {
                objectUrl: `blob:mouse-scroll:page-${String(pageNumber)}:${String(targetWidthPx)}`,
                renderedPx: targetWidthPx,
            };
        });
        nativePdfMocks.createSource.mockReturnValue(source);
        const host = document.createElement('div');
        const viewport = document.createElement('div');
        document.body.append(host, viewport);
        Object.defineProperties(viewport, {
            clientHeight: {
                configurable: true,
                value: 600,
            },
            clientWidth: {
                configurable: true,
                value: 800,
            },
        });
        const authority = createDocumentViewerChassisAuthority(ref('pdf'));
        authority.bindViewportElement(viewport);
        authority.openSurface.begin({
            documentId: documentPath,
            documentRevision: 'drt1:test:mouse-scroll',
        });
        const currentPageUpdates: number[] = [];
        const Root = defineComponent({setup() {
            provide(documentViewerChassisAuthorityKey, authority);
            return () => h(NativePdfViewer, {
                src: documentPath,
                isActive: true,
                currentPage: 1,
                'onUpdate:currentPage': (pageNumber: number) => currentPageUpdates.push(pageNumber),
            });
        }});
        const app = createApp(Root);
        const ElementStub = defineComponent({setup: () => () => h('span')});
        app.component('UButton', ElementStub);
        app.component('UIcon', ElementStub);
        app.component('USkeleton', ElementStub);
        app.mount(host);
        const unmount = () => {
            app.unmount();
            host.remove();
            viewport.remove();
            activeUnmounts.delete(unmount);
        };
        activeUnmounts.add(unmount);

        await settlePendingWork();
        await settleImagePaint(requireElement<HTMLImageElement>(
            host,
            'img[src="blob:mouse-scroll:page-1:760"]',
        ));
        await settlePendingWork();
        expect(authority.openSurface.viewportSession.value.lifecycle).toBe('ready');

        const pageOneCallsBeforeDensityChange = source.renderPageObjectUrl.mock.calls
            .filter(([pageNumber]) => pageNumber === 1).length;
        if (!vueUseMocks.pixelRatio) throw new Error('Device pixel ratio mock was not initialized');
        vueUseMocks.pixelRatio.value = 2;
        await settlePendingWork();
        expect(source.renderPageObjectUrl).toHaveBeenCalledWith(1, {targetWidthPx: 1_520});
        expect(host.querySelector('img[src="blob:mouse-scroll:page-1:760"]')).toBeNull();
        expect(host.querySelector('[data-page-number="1"] .document-page-skeleton')).not.toBeNull();
        const highDensityImage = requireElement<HTMLImageElement>(
            host,
            'img[src="blob:mouse-scroll:page-1:1520"]',
        );
        expect(host.querySelector('[data-page-number="1"] .document-page-visual--committed')).toBeNull();
        await settleImagePaint(highDensityImage);
        expect(host.querySelector('[data-page-number="1"] .document-page-skeleton')).toBeNull();
        const pageOneCallsAfterUpscale = source.renderPageObjectUrl.mock.calls
            .filter(([pageNumber]) => pageNumber === 1).length;
        expect(pageOneCallsAfterUpscale).toBe(pageOneCallsBeforeDensityChange + 1);
        vueUseMocks.pixelRatio.value = 1;
        await settlePendingWork();
        expect(source.renderPageObjectUrl.mock.calls.filter(([pageNumber]) => pageNumber === 1))
            .toHaveLength(pageOneCallsAfterUpscale);

        viewport.scrollTop = 1_700;
        authority.dispatchViewportEvent('scroll', new Event('scroll'));
        await nextTick();

        expect(authority.openSurface.viewportSession.value).toMatchObject({
            requestedPage: 1,
            committedPage: 1,
            observedPage: 2,
        });
        expect(authority.currentPage.value).toBe(2);
        expect(currentPageUpdates.at(-1)).toBe(2);
        const pageTwoImage = requireElement<HTMLImageElement>(
            host,
            'img[src="blob:mouse-scroll:page-2:1520"]',
        );
        expect(host.querySelector('[data-page-number="2"] .document-page-skeleton')).not.toBeNull();
        await settleImagePaint(pageTwoImage);
        expect(host.querySelector('[data-page-number="2"] .document-page-visual--committed')).not.toBeNull();
        expect(host.querySelector('[data-page-number="2"] .document-page-skeleton')).toBeNull();
    });

    it('invalidates a budget-evicted current visual until its replacement paint settles', async () => {
        vi.useFakeTimers();
        class PreloadImage {
            onload: (() => void) | null = null;
            onerror: (() => void) | null = null;

            set src(_value: string) {
                queueMicrotask(() => this.onload?.());
            }
        }
        vi.stubGlobal('Image', PreloadImage);

        const documentPath = '/managed/evicted-current-page.pdf';
        const source = createEvictableSource();
        nativePdfMocks.createSource.mockReturnValue(source);
        const host = document.createElement('div');
        const viewport = document.createElement('div');
        document.body.append(host, viewport);
        Object.defineProperties(viewport, {
            clientHeight: {
                configurable: true,
                value: 600,
            },
            clientWidth: {
                configurable: true,
                value: 800,
            },
        });
        const authority = createDocumentViewerChassisAuthority(ref('pdf'));
        authority.bindViewportElement(viewport);
        authority.openSurface.begin({
            documentId: documentPath,
            documentRevision: 'drt1:test:eviction',
        });
        const isLoading = ref(true);
        let waitForWorkspaceSettle: ReturnType<
            typeof useDocumentOpenVisualSettle
        >['waitForDocumentOpenSettled'] = () => Promise.reject(new Error('Workspace settle was not bound'));
        let isWorkspaceVisualReady = () => false;
        const Root = defineComponent({setup() {
            provide(documentViewerChassisAuthorityKey, authority);
            const settle = useDocumentOpenVisualSettle({
                tabId: 'eviction-tab',
                hasPdf: ref(false),
                pdfSrc: ref(null),
                pdfDocument: ref(null),
                totalPages: ref(2),
                pageLabelsResolved: ref(false),
                isLoading,
                pdfError: ref(null),
                djvuError: ref(null),
                showDjvuSource: ref(false),
                showNativePdfViewer: ref(true),
                openSurface: authority.openSurface,
                markAnnotationCommentsLoading: vi.fn(),
            });
            waitForWorkspaceSettle = settle.waitForDocumentOpenSettled;
            isWorkspaceVisualReady = () => settle.initialDocumentVisualReady.value;
            return () => h(NativePdfViewer, {
                src: documentPath,
                isActive: true,
                currentPage: 1,
                onLoading: (loading: boolean) => { isLoading.value = loading; },
            });
        }});
        const app = createApp(Root);
        const ElementStub = defineComponent({setup: () => () => h('span')});
        app.component('UButton', ElementStub);
        app.component('UIcon', ElementStub);
        app.component('USkeleton', ElementStub);
        app.mount(host);
        const unmount = () => {
            app.unmount();
            host.remove();
            viewport.remove();
            activeUnmounts.delete(unmount);
        };
        activeUnmounts.add(unmount);

        await settlePendingWork();
        const initialImage = requireElement<HTMLImageElement>(
            host,
            'img[src="blob:eviction:page-1:render-1"]',
        );
        await settleImagePaint(initialImage);
        await settlePendingWork();
        await expect(waitForWorkspaceSettle()).resolves.toBeUndefined();
        expect(isWorkspaceVisualReady()).toBe(true);
        expect(source.renderPageObjectUrl).toHaveBeenCalledWith(2, {targetWidthPx: 760});

        source.evictPage(2, () => {
            expect(authority.openSurface.viewportSession.value.lifecycle).toBe('ready');
            expect(source.evictedObjectUrls).not.toContain('blob:eviction:page-2:render-1');
            expect(host.querySelector('img[src="blob:eviction:page-1:render-1"]')).not.toBeNull();
        });
        await nextTick();
        expect(authority.openSurface.viewportSession.value.lifecycle).toBe('ready');
        expect(isWorkspaceVisualReady()).toBe(true);
        expect(host.querySelector('img[src="blob:eviction:page-1:render-1"]')).not.toBeNull();

        source.evictPage(1, () => {
            expect(authority.openSurface.viewportSession.value).toMatchObject({
                lifecycle: 'transitioning',
                requestedPage: 1,
                visual: {
                    pageNumber: 1,
                    presentation: 'skeleton',
                },
            });
            expect(source.evictedObjectUrls).not.toContain('blob:eviction:page-1:render-1');
        });
        expect(source.evictedObjectUrls).toContain('blob:eviction:page-1:render-1');
        await nextTick();
        expect(authority.openSurface.viewportSession.value).toMatchObject({
            lifecycle: 'transitioning',
            requestedPage: 1,
            visual: {
                pageNumber: 1,
                presentation: 'skeleton',
            },
        });
        expect(isWorkspaceVisualReady()).toBe(false);
        expect(host.querySelector('img[src="blob:eviction:page-1:render-1"]')).toBeNull();
        expect(host.querySelector('[data-page-number="1"] .document-page-skeleton')).not.toBeNull();
        vi.advanceTimersToNextFrame();
        await vi.advanceTimersByTimeAsync(0);
        expect(
            host.querySelector('img[src="blob:eviction:page-1:render-1"]')
            ?? host.querySelector('[data-page-number="1"] .document-page-skeleton'),
        ).not.toBeNull();

        const replacementSettle = waitForWorkspaceSettle();
        let replacementSettled = false;
        void replacementSettle.then(() => {
            replacementSettled = true;
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(replacementSettled).toBe(false);

        expect(authority.openSurface.supersede()).not.toBeNull();
        expect(authority.openSurface.snapshot.value.phase).not.toBe('ready');
        expect(authority.openSurface.snapshot.value.presentation).toBe('idle');
        source.resolveCurrentPageReplacement();
        await settlePendingWork();
        const replacementImage = requireElement<HTMLImageElement>(
            host,
            'img[src="blob:eviction:page-1:render-2"]',
        );
        expect(authority.openSurface.snapshot.value.phase).not.toBe('ready');
        expect(authority.openSurface.snapshot.value.presentation).toBe('idle');
        expect(host.querySelector('[data-page-number="1"] .document-page-skeleton')).not.toBeNull();
        expect(replacementSettled).toBe(false);

        await settleImagePaint(replacementImage);
        await replacementSettle;
        expect(replacementSettled).toBe(true);
        expect(isWorkspaceVisualReady()).toBe(true);
        expect(authority.openSurface.viewportSession.value.lifecycle).toBe('ready');
        expect(host.querySelector('[data-page-number="1"] .document-page-skeleton')).toBeNull();
        expect(host.querySelector('.document-page-visual--committed img')?.getAttribute('src'))
            .toBe('blob:eviction:page-1:render-2');
        expect(source.revokeObjectURL)
            .not.toHaveBeenCalledWith('blob:eviction:page-1:render-1');
        expect(source.revokeObjectURL)
            .not.toHaveBeenCalledWith('blob:eviction:page-2:render-1');
    });
});
