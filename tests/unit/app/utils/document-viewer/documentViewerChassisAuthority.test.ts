import {
    describe,
    expect,
    it,
} from 'vitest';
import { ref } from 'vue';
import { createDocumentViewerChassisAuthority } from '@app/utils/document-viewer/chassis/documentViewerChassisAuthority';
import type { IDocumentPageSource } from '@app/utils/document-viewer/source/documentPageSource';

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
        expect(authority.viewportWritePort.consumeAuthorityScroll(container)).toBe(false);

        container.scrollTop = 725;
        authority.viewportWritePort.observeUserScroll(container);
        expect(() => authority.viewportWritePort.assertNoRogueWrite(container)).not.toThrow();
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
        authority.bindViewportElement(container);

        const releasePdf = authority.bindViewportFeature({
            getClass: () => 'pdfViewer',
            getStyle: () => ({zoom: 2}),
            events: {scroll: () => received.push('pdf')},
        });
        authority.dispatchViewportEvent('scroll');
        expect(authority.viewportElement.value).toBe(container);
        expect(authority.viewportClass.value).toBe('pdfViewer');

        releasePdf();
        authority.bindViewportFeature({
            getClass: () => 'document-source-viewer',
            getStyle: () => ({}),
            events: {scroll: () => received.push('djvu')},
        });
        authority.dispatchViewportEvent('scroll');

        expect(authority.viewportElement.value).toBe(container);
        expect(authority.viewportClass.value).toBe('document-source-viewer');
        expect(received).toEqual([
            'pdf',
            'djvu',
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
});
