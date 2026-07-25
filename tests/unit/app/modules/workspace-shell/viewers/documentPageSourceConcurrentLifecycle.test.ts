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
    type Ref,
} from 'vue';
import type { TDocumentRef } from '@contracts/documentRef';
import {requireDocumentRevisionToken} from '@contracts/documentRevision';
import DocumentPageSourceFeaturePack from '@app/modules/workspace-shell/components/DocumentPageSourceFeaturePack.vue';
import { useDocumentOpenVisualSettle } from '@app/modules/workspace-shell/composables/useDocumentOpenVisualSettle';
import {
    createDocumentOpenSurfaceSession,
    type IDocumentOpenSurfaceSession,
} from '@app/utils/document-viewer/chassis/documentOpenSurfaceSession';
import {
    createDocumentViewerChassisAuthority,
    documentViewerChassisAuthorityKey,
} from '@app/utils/document-viewer/chassis/documentViewerChassisAuthority';
import type { IDocumentPageSource } from '@app/utils/document-viewer/source/documentPageSource';

const mocks = vi.hoisted(() => ({
    createDjvuPagePreviewSourceFromPath: vi.fn(),
    createDjvuPageSource: vi.fn(),
}));

vi.mock('@app/platform/browser-api/public', () => ({createDjvuPagePreviewSourceFromPath:
    mocks.createDjvuPagePreviewSourceFromPath}));
vi.mock('@app/utils/document-viewer/source/createDjvuPageSource', () => ({createDjvuPageSource:
    mocks.createDjvuPageSource}));

const mountedApps = new Set<() => void>();

interface IWorkspaceOpenSettleHarness {
    initialVisualReady: Ref<boolean>;
    waitForDocumentOpenSettled: () => Promise<void>;
}

function createWorkspaceOpenSettleHarness(): IWorkspaceOpenSettleHarness {
    return {
        initialVisualReady: ref(false),
        waitForDocumentOpenSettled: () => Promise.reject(new Error('Workspace host is not mounted')),
    };
}

function createPageSource(documentRef: TDocumentRef): IDocumentPageSource {
    return {
        kind: 'djvu',
        documentRef,
        pageCount: 1,
        getPageMetrics: vi.fn(async () => ({
            widthPoints: 600,
            heightPoints: 800,
            rotation: 0 as const,
        })),
        renderPage: vi.fn(async () => ({
            bytes: 480_000,
            heightPx: 800,
            release: vi.fn(),
            surface: 'data:image/png;base64,',
            widthPx: 600,
        })),
        dispose: vi.fn(),
    };
}

function createFeaturePackHost(
    surface: IDocumentOpenSurfaceSession,
    documentRef: TDocumentRef,
    loadErrors: Ref<unknown[]>,
    settleHarness: IWorkspaceOpenSettleHarness,
    isResizing: Ref<boolean>,
) {
    return defineComponent({
        name: 'DocumentPageSourceFeaturePackHost',
        setup() {
            const authority = createDocumentViewerChassisAuthority(ref('djvu'), 1, surface);
            const totalPages = ref(0);
            const isLoading = ref(false);
            const settle = useDocumentOpenVisualSettle({
                tabId: String(documentRef),
                hasPdf: ref(false),
                pdfSrc: ref(null),
                pdfDocument: ref(null),
                totalPages,
                pageLabelsResolved: ref(false),
                isLoading,
                pdfError: ref(null),
                djvuError: ref(null),
                showDjvuSource: ref(true),
                openSurface: surface,
                markAnnotationCommentsLoading: vi.fn(),
            });
            settleHarness.initialVisualReady = settle.initialDocumentVisualReady;
            settleHarness.waitForDocumentOpenSettled = settle.waitForDocumentOpenSettled;
            provide(documentViewerChassisAuthorityKey, authority);
            return () => {
                const snapshot = surface.snapshot.value;
                return h('div', {
                    ref: (element: unknown) => {
                        authority.bindViewportElement(element instanceof HTMLElement ? element : null);
                    },
                    class: 'document-viewer-viewport',
                    'data-document-ref': documentRef,
                }, [
                    h('section', {
                        ref: (element: unknown) => {
                            authority.bindOpeningPageElement(element instanceof HTMLElement ? element : null);
                        },
                        'data-document-page-number': '1',
                        'data-open-surface-frame-owner': snapshot.openingPageFrame?.ownerId ?? '',
                        'data-open-surface-generation': String(snapshot.generation),
                        'data-page-number': '1',
                    }),
                    h(DocumentPageSourceFeaturePack, {
                        currentPage: 1,
                        documentRevisionToken: requireDocumentRevisionToken(`revision:${documentRef}`),
                        isActive: true,
                        isResizing: isResizing.value,
                        onInitialVisualPending: settle.handlePdfInitialVisualPending,
                        onInitialVisualReady: settle.handlePdfInitialVisualReady,
                        onLoadError: (error: unknown) => loadErrors.value.push(error),
                        onLoading: (loading: boolean) => {
                            isLoading.value = loading;
                        },
                        'onUpdate:totalPages': (pageCount: number) => {
                            totalPages.value = pageCount;
                        },
                        src: documentRef,
                    }),
                ]);
            };
        },
    });
}

afterEach(() => {
    for (const unmount of mountedApps) unmount();
    document.body.innerHTML = '';
    vi.restoreAllMocks();
});

describe('DocumentPageSourceFeaturePack concurrent open surfaces', () => {
    it('settles a cold second workspace after its opening image is relocated', async () => {
        vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(900);
        vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(700);
        vi.spyOn(HTMLImageElement.prototype, 'complete', 'get').mockReturnValue(true);
        vi.spyOn(HTMLImageElement.prototype, 'naturalWidth', 'get').mockReturnValue(600);
        vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
            bottom: 1_146,
            height: 1_146,
            left: 0,
            right: 860,
            top: 0,
            width: 860,
            x: 0,
            y: 0,
            toJSON: () => ({}),
        });
        mocks.createDjvuPagePreviewSourceFromPath.mockImplementation(async (path: TDocumentRef) => ({path}));
        mocks.createDjvuPageSource.mockImplementation(async (path: TDocumentRef) => createPageSource(path));

        const firstDocumentRef = '/documents/first.djvu' as TDocumentRef;
        const secondDocumentRef = '/documents/second.djvu' as TDocumentRef;
        const firstSurface = createDocumentOpenSurfaceSession();
        const secondSurface = createDocumentOpenSurfaceSession();
        const firstGeneration = firstSurface.begin({
            documentId: firstDocumentRef,
            documentRevision: 'open-intent:first',
        }, {
            documentId: firstDocumentRef,
            height: 800,
            pageCount: 1,
            pageNumber: 1,
            rotation: 0,
            width: 600,
        });
        const secondGeneration = secondSurface.begin({
            documentId: secondDocumentRef,
            documentRevision: 'open-intent:second',
        });
        const secondGeometryCommit = vi.spyOn(secondSurface, 'commitGeometry');
        const firstLoadErrors = ref<unknown[]>([]);
        const secondLoadErrors = ref<unknown[]>([]);
        const firstSettle = createWorkspaceOpenSettleHarness();
        const secondSettle = createWorkspaceOpenSettleHarness();
        const firstWorkspaceIsResizing = ref(false);
        const secondWorkspaceIsResizing = ref(false);
        const FirstHost = createFeaturePackHost(
            firstSurface,
            firstDocumentRef,
            firstLoadErrors,
            firstSettle,
            firstWorkspaceIsResizing,
        );
        const SecondHost = createFeaturePackHost(
            secondSurface,
            secondDocumentRef,
            secondLoadErrors,
            secondSettle,
            secondWorkspaceIsResizing,
        );
        const showSecondWorkspace = ref(false);
        const root = document.createElement('div');
        document.body.append(root);
        const app = createApp(defineComponent({setup: () => () => h('div', [
            h(FirstHost),
            showSecondWorkspace.value ? h(SecondHost) : null,
        ])}));
        app.component('USkeleton', defineComponent({setup: () => () => h('span')}));
        app.mount(root);
        const unmount = () => {
            app.unmount();
            root.remove();
            mountedApps.delete(unmount);
        };
        mountedApps.add(unmount);

        await vi.waitFor(() => expect(firstSurface.snapshot.value.geometry).not.toBeNull());
        const firstImage = await vi.waitFor(() => {
            const image = root.querySelector<HTMLImageElement>(
                '[data-document-ref="/documents/first.djvu"] [data-testid="document-page-source-image"]',
            );
            expect(image).not.toBeNull();
            return image!;
        });
        const firstSettled = firstSettle.waitForDocumentOpenSettled();
        firstImage.dispatchEvent(new Event('load'));
        await vi.waitFor(() => expect(firstSettle.initialVisualReady.value).toBe(true));
        await expect(firstSettled).resolves.toBeUndefined();

        showSecondWorkspace.value = true;
        await nextTick();
        await vi.waitFor(() => expect(secondSurface.snapshot.value.geometry).not.toBeNull());
        const secondImage = await vi.waitFor(() => {
            const image = root.querySelector<HTMLImageElement>(
                '[data-document-ref="/documents/second.djvu"] [data-testid="document-page-source-image"]',
            );
            expect(image).not.toBeNull();
            return image!;
        });
        const secondSettled = secondSettle.waitForDocumentOpenSettled();
        const openingTarget = secondImage.parentElement!;
        const openingTargetParent = openingTarget.parentElement!;
        secondImage.dispatchEvent(new Event('load'));
        openingTarget.remove();
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
        openingTargetParent.append(openingTarget);
        secondWorkspaceIsResizing.value = true;
        await nextTick();
        secondWorkspaceIsResizing.value = false;

        await vi.waitFor(() => expect(secondSettle.initialVisualReady.value).toBe(true));
        await expect(secondSettled).resolves.toBeUndefined();

        expect(firstSurface.snapshot.value.generation).toBe(firstGeneration);
        expect(firstSurface.snapshot.value.phase).toBe('ready');
        expect(secondSurface.snapshot.value.generation).toBe(secondGeneration);
        expect(secondSurface.snapshot.value.phase).toBe('ready');
        expect(secondGeometryCommit.mock.results.map(result => result.value)).toEqual([true]);
        expect(firstLoadErrors.value).toEqual([]);
        expect(secondLoadErrors.value).toEqual([]);
    });
});
