import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {
    describe,
    expect,
    it,
} from 'vitest';

const root = process.cwd();
const read = (relativePath: string) => readFileSync(join(root, relativePath), 'utf8');

describe('document thumbnail architecture boundaries', () => {
    it('composes the same Pages panel, rail, and item presentation in PDF and page-source formats', () => {
        const pdfSidebar = read('app/modules/pdf-viewer/components/PdfSidebar.vue');
        const sourceSidebar = read('app/modules/workspace-shell/components/DocumentSourceSidebar.vue');
        const pdfThumbnails = read('app/modules/pdf-viewer/components/PdfThumbnails.vue');
        const sourceThumbnails = read('app/components/document-viewer/DocumentThumbnailList.vue');

        for (const sidebar of [
            pdfSidebar,
            sourceSidebar,
        ]) {
            expect(sidebar).toContain('DocumentSidebarPagesPanel');
        }
        for (const thumbnails of [
            pdfThumbnails,
            sourceThumbnails,
        ]) {
            expect(thumbnails).toContain('DocumentThumbnailRail');
            expect(thumbnails).toContain('DocumentThumbnailItem');
        }
    });

    it('keeps rail chrome and current-page semantics out of format-owned styles', () => {
        const pdfStyles = read('app/modules/pdf-viewer/components/PdfThumbnails.css');
        const sourceThumbnails = read('app/components/document-viewer/DocumentThumbnailList.vue');
        const commonRail = read('app/components/document-viewer/DocumentThumbnailRail.vue');
        const commonItem = read('app/components/document-viewer/DocumentThumbnailItem.vue');

        expect(commonRail).toContain('background: var(--app-document-thumbnails-background)');
        expect(commonItem).toContain(':aria-current="current ? \'page\' : undefined"');
        expect(commonItem).toContain('\'is-selected\': selected');
        expect(pdfStyles).not.toMatch(/\.pdf-thumbnails\s*\{[^}]*background/su);
        expect(pdfStyles).not.toContain('.pdf-thumbnail.is-active');
        expect(sourceThumbnails).not.toMatch(/\.document-thumbnail-list\s*\{[^}]*background/su);
        expect(sourceThumbnails).not.toContain('.document-thumbnail-list__item.is-current');
    });

    it('forwards virtual-row overlay and label slots without creating an eager row path', () => {
        const sourceThumbnails = read('app/components/document-viewer/DocumentThumbnailList.vue');

        expect(sourceThumbnails).toContain('<slot name="overlay" :page-number="item.pageNumber" />');
        expect(sourceThumbnails).toContain('<slot name="label" :page-number="item.pageNumber">');
        expect(sourceThumbnails).toContain('v-for="item in virtualItems"');
        expect(sourceThumbnails).not.toContain('v-for="page in source.pageCount"');
    });

    it('uses one shared layout and reveal policy instead of a PDF geometry fork', () => {
        const pdfThumbnails = read('app/modules/pdf-viewer/components/PdfThumbnails.vue');
        const sourceController = read('app/utils/document-viewer/thumbnails/useDocumentThumbnailController.ts');

        for (const source of [
            pdfThumbnails,
            sourceController,
        ]) {
            expect(source).toContain('DocumentThumbnailLayout');
            expect(source).toContain('resolveDocumentThumbnailRevealScrollTop');
        }
        expect(pdfThumbnails).not.toContain('ThumbnailFenwickLayout');
    });

    it('keeps capability reconciliation in one shared session without format watchers rewriting preference', () => {
        const pdfSidebar = read('app/modules/pdf-viewer/components/PdfSidebar.vue');
        const sourceSidebar = read('app/modules/workspace-shell/components/DocumentSourceSidebar.vue');

        for (const sidebar of [
            pdfSidebar,
            sourceSidebar,
        ]) {
            expect(sidebar).toContain('useDocumentSidebarCapabilitySession');
            expect(sidebar).toContain('effectiveTab');
        }
        expect(sourceSidebar).not.toContain('watch(availableTabs');
        expect(sourceSidebar).not.toContain('reconcileDocumentSidebarTab');
    });
});
