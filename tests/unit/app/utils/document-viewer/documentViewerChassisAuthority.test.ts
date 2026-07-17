import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { ref } from 'vue';
import {
    createDocumentViewerChassisAuthority,
    shouldAcceptFeaturePackChassisPage,
    shouldApplyExternalChassisPage,
} from '@app/utils/document-viewer/chassis/documentViewerChassisAuthority';
import { createDocumentOpenSurfaceSession } from '@app/utils/document-viewer/chassis/documentOpenSurfaceSession';
import type { IDocumentPageSource } from '@app/utils/document-viewer/source/documentPageSource';
import { cast } from '@tests/helpers/cast';

function createSource(kind: 'pdf' | 'djvu', pageCount: number): IDocumentPageSource {
    return {
        kind,
        documentRef: `document.${kind}`,
        pageCount,
        getPageMetrics: async () => ({
            widthPoints: 612,
            heightPoints: 792,
            rotation: 0,
        }),
        renderPage: async () => {
            throw new Error('Not used by the authority contract');
        },
        dispose() {},
    };
}

describe('document viewer chassis authority', () => {
    it('scopes opening-page elements to a unique chassis instance', () => {
        const first = createDocumentViewerChassisAuthority(ref('djvu'));
        const second = createDocumentViewerChassisAuthority(ref('djvu'));
        const element = {} as HTMLElement;

        expect(first.instanceId).not.toBe(second.instanceId);
        expect(first.openingPageElement.value).toBeNull();
        first.bindOpeningPageElement(element);
        expect(first.openingPageElement.value).toBe(element);
        expect(second.openingPageElement.value).toBeNull();
        first.bindOpeningPageElement(null);
        expect(first.openingPageElement.value).toBeNull();
    });

    it('publishes opening-page visual state only through the connected owned frame', () => {
        const authority = createDocumentViewerChassisAuthority(ref('djvu'));
        const generation = authority.openSurface.begin({
            documentId: '/documents/scan.djvu',
            documentRevision: 'revision-1',
        });
        expect(authority.openSurface.commitOpeningPageFrame(generation, {
            generation,
            ownerId: 'chassis-owner',
            pageNumber: 3,
            intentKey: 'fit-width:1',
            style: {
                width: '600px',
                height: '800px',
            },
        })).toBe(true);
        authority.bindOpeningPageElement(cast<HTMLElement>({
            isConnected: true,
            dataset: {
                openSurfaceFrameOwner: 'chassis-owner',
                openSurfaceGeneration: String(generation),
                pageNumber: '3',
            },
        }));

        expect(authority.commitOpeningPageVisual(generation - 1, 3, 'fresh')).toBe(false);
        expect(authority.commitOpeningPageVisual(generation, 2, 'fresh')).toBe(false);
        expect(authority.openingPageVisual.value).toBe('skeleton');
        expect(authority.commitOpeningPageVisual(generation, 3, 'fresh')).toBe(true);
        expect(authority.openingPageVisual.value).toBe('fresh');
        authority.openSurface.begin({
            documentId: '/documents/next.djvu',
            documentRevision: 'revision-2',
        });
        expect(authority.openingPageVisual.value).toBe('skeleton');
    });

    it('keeps one navigation, page-slot, and surface-budget authority across PDF and DjVu sources', async () => {
        const sourceKind = ref<'pdf' | 'djvu'>('pdf');
        const authority = createDocumentViewerChassisAuthority(sourceKind, 2);
        const originalSlots = authority.pageSlots;
        const originalBudget = authority.surfaceBudget;
        const originalViewportWritePort = authority.viewportWritePort;
        authority.bindSource(createSource('pdf', 12));

        expect(authority.navigate(7)).toBe(7);
        const mounted = authority.pageSlots.whenMounted(7, new AbortController().signal);
        authority.pageSlots.markMounted(7);
        await expect(mounted).resolves.toBeUndefined();

        sourceKind.value = 'djvu';
        authority.bindSource(createSource('djvu', 12));

        expect(authority.sourceKind.value).toBe('djvu');
        expect(authority.currentPage.value).toBe(7);
        expect(authority.pageSlots).toBe(originalSlots);
        expect(authority.pageSlots.isMounted(7)).toBe(true);
        expect(authority.surfaceBudget).toBe(originalBudget);
        expect(authority.viewportWritePort).toBe(originalViewportWritePort);
    });

    it('origin-fences authority scrolls and recognizes subsequent native user input', () => {
        const authority = createDocumentViewerChassisAuthority(ref('pdf'));
        const container = {
            scrollLeft: 0,
            scrollTop: 0,
        } as HTMLElement;

        authority.viewportWritePort.apply(container, {
            intent: authority.viewportWritePort.beginIntent('navigate:7'),
            reason: 'navigation',
            top: 700,
        });

        expect(authority.viewportWritePort.consumeAuthorityScroll(container)).toBe(true);
        expect(authority.viewportWritePort.consumeAuthorityScroll(container)).toBe(true);

        container.scrollTop = 725;
        expect(authority.viewportWritePort.consumeAuthorityScroll(container)).toBe(false);
        authority.viewportWritePort.observeUserScroll(container);
        expect(() => authority.viewportWritePort.assertNoRogueWrite(container)).not.toThrow();
    });

    it('resets a stale viewport offset synchronously when a document generation begins', () => {
        const openSurface = createDocumentOpenSurfaceSession();
        const authority = createDocumentViewerChassisAuthority(ref('pdf'), 1, openSurface);
        const container = {
            scrollLeft: 7,
            scrollTop: 4,
        } as HTMLElement;
        authority.bindViewportElement(container);

        openSurface.begin({
            documentId: 'scan.pdf',
            documentRevision: 'open-intent:1',
        });

        expect(container.scrollLeft).toBe(0);
        expect(container.scrollTop).toBe(0);
        expect(authority.viewportWritePort.consumeAuthorityScroll(container)).toBe(true);
    });

    it('rejects stale continuations after supersession, user input, and source revision changes', () => {
        const authority = createDocumentViewerChassisAuthority(ref('pdf'));
        const container = {
            scrollLeft: 0,
            scrollTop: 0,
        } as HTMLElement;
        const staleByIntent = authority.viewportWritePort.beginIntent('navigate:old');
        const current = authority.viewportWritePort.beginIntent('navigate:new');

        expect(authority.viewportWritePort.apply(container, {
            intent: staleByIntent,
            reason: 'late-old-navigation',
            top: 100,
        })).toBe(false);
        expect(authority.viewportWritePort.apply(container, {
            intent: current,
            reason: 'latest-navigation',
            top: 200,
        })).toBe(true);
        expect(container.scrollTop).toBe(200);

        const staleByInteraction = authority.viewportWritePort.beginIntent('resize-restore');
        authority.viewportWritePort.observeUserScroll(container);
        expect(authority.viewportWritePort.apply(container, {
            intent: staleByInteraction,
            reason: 'late-resize',
            top: 300,
        })).toBe(false);

        const staleByDocument = authority.viewportWritePort.beginIntent('document-a-restore');
        authority.bindSource(createSource('pdf', 4));
        expect(authority.viewportWritePort.apply(container, {
            intent: staleByDocument,
            reason: 'late-document-a',
            top: 400,
        })).toBe(false);
        expect(container.scrollTop).toBe(200);
    });

    it('rebinds feature presentation and events without replacing the chassis viewport', () => {
        const authority = createDocumentViewerChassisAuthority(ref('pdf'));
        const container = {
            scrollLeft: 0,
            scrollTop: 0,
        } as HTMLElement;
        const received: string[] = [];
        const interaction = {
            deltaPx: 120,
            event: cast<WheelEvent>({preventDefault: vi.fn()}),
            intent: 'platform-scroll' as const,
        };
        authority.bindViewportElement(container);

        const releasePdf = authority.bindViewportFeature({
            getClass: () => 'pdfViewer',
            getStyle: () => ({zoom: 2}),
            events: {scroll: () => received.push('pdf')},
            wheel: value => received.push(`pdf-${value.intent}`),
        });
        authority.dispatchViewportEvent('scroll');
        authority.dispatchViewportWheel(interaction);
        expect(authority.viewportElement.value).toBe(container);
        expect(authority.viewportClass.value).toBe('pdfViewer');

        releasePdf();
        authority.bindViewportFeature({
            getClass: () => 'document-source-viewer',
            getStyle: () => ({}),
            events: {scroll: () => received.push('djvu')},
            wheel: value => received.push(`djvu-${value.intent}`),
        });
        authority.dispatchViewportEvent('scroll');
        authority.dispatchViewportWheel(interaction);

        expect(authority.viewportElement.value).toBe(container);
        expect(authority.viewportClass.value).toBe('document-source-viewer');
        expect(received).toEqual([
            'pdf',
            'pdf-platform-scroll',
            'djvu',
            'djvu-platform-scroll',
        ]);
    });

    it('rejects a feature pack that attempts to bind a source of the wrong kind', () => {
        const authority = createDocumentViewerChassisAuthority(ref('pdf'));

        expect(() => authority.bindSource(createSource('djvu', 3))).toThrow(
            'Cannot bind djvu source to pdf chassis',
        );
    });

    it('clamps navigation only after the source page count is known', () => {
        const authority = createDocumentViewerChassisAuthority(ref('djvu'));

        expect(authority.navigate(20)).toBe(20);
        authority.pageCount.value = 8;
        expect(authority.navigate(20)).toBe(8);
        expect(authority.navigate(-4)).toBe(1);
    });

    it('delegates navigation dedupe to the owned open-surface session', () => {
        const openSurface = createDocumentOpenSurfaceSession();
        openSurface.begin({
            documentId: 'scan.pdf',
            documentRevision: 'open-intent:1',
        });
        const requestNavigation = vi.spyOn(openSurface, 'requestNavigation');
        const authority = createDocumentViewerChassisAuthority(ref('pdf'), 1, openSurface);

        expect(authority.navigate(1)).toBe(1);
        expect(requestNavigation).toHaveBeenCalledOnce();
        expect(requestNavigation).toHaveBeenCalledWith(1);
    });

    it('mounts on the latest opening-session intent instead of the stale initial page', () => {
        const openSurface = createDocumentOpenSurfaceSession();
        openSurface.begin({
            documentId: 'scan.pdf',
            documentRevision: 'open-intent:1',
        });
        for (let page = 2; page <= 6; page += 1) {
            openSurface.requestNavigation(page);
        }

        const authority = createDocumentViewerChassisAuthority(ref('pdf'), 1, openSurface);

        expect(openSurface.viewportSession.value.requestedPage).toBe(6);
        expect(authority.currentPage.value).toBe(6);
        expect(shouldApplyExternalChassisPage(openSurface.viewportSession.value, 1)).toBe(false);
        expect(shouldApplyExternalChassisPage(openSurface.viewportSession.value, 6)).toBe(true);
        expect(shouldApplyExternalChassisPage({
            ...openSurface.viewportSession.value,
            lifecycle: 'transitioning',
        }, 1)).toBe(false);
        expect(shouldAcceptFeaturePackChassisPage(openSurface.viewportSession.value, 1)).toBe(false);
        expect(shouldAcceptFeaturePackChassisPage(openSurface.viewportSession.value, 6)).toBe(true);
        expect(shouldAcceptFeaturePackChassisPage({
            ...openSurface.viewportSession.value,
            committedPage: 6,
        }, 7)).toBe(false);
        expect(shouldAcceptFeaturePackChassisPage({
            ...openSurface.viewportSession.value,
            requestedPage: 7,
            committedPage: 6,
        }, 7)).toBe(true);
    });

    it('rejects navigation without a document owner instead of leaking it into the next open', () => {
        const openSurface = createDocumentOpenSurfaceSession();
        const authority = createDocumentViewerChassisAuthority(ref('pdf'), 1, openSurface);

        expect(shouldAcceptFeaturePackChassisPage(openSurface.viewportSession.value, 6)).toBe(false);

        for (let page = 2; page <= 6; page += 1) {
            authority.navigate(page);
        }
        expect(authority.currentPage.value).toBe(6);
        expect(openSurface.viewportSession.value.identity).toBeNull();

        openSurface.begin({
            documentId: 'scan.pdf',
            documentRevision: 'open-intent:1',
        });

        expect(openSurface.viewportSession.value.requestedPage).toBe(1);
        expect(authority.currentPage.value).toBe(1);
    });
});
