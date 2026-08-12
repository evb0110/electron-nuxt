import {
    readFileSync,
    realpathSync,
} from 'node:fs';
import { join } from 'node:path';
import {
    describe,
    expect,
    it,
} from 'vitest';

const root = realpathSync(process.cwd());
function read(relativePath: string) {
    return readFileSync(join(root, relativePath), 'utf8');
}

describe('PDF physical page-track contract', () => {
    it('keeps pages and virtual spacers adjacent under a real track in chassis mode', () => {
        const viewport = read('app/modules/pdf-viewer/components/PdfViewerViewport.vue');

        expect(viewport).toContain('class="pdf-viewer-page-track"');
        expect(viewport).toContain('data-pdf-page-track');
        expect(viewport).not.toContain('chassisAuthority ? \'contents\'');
        expect(viewport.indexOf('<template v-for="item in virtualPageItems"'))
            .toBeGreaterThan(viewport.indexOf('data-pdf-page-track'));
        expect(viewport.indexOf('v-if="bottomVirtualSpacerStyle"'))
            .toBeGreaterThan(viewport.indexOf('<template v-for="item in virtualPageItems"'));
    });

    it('assigns flex/grid and box geometry to the page track rather than the chassis scroll root', () => {
        const css = read('app/assets/css/pdf-viewer.scss');
        const trackRule = css.slice(
            css.indexOf('.pdf-viewer-page-track {'),
            css.indexOf('.pdfViewer .page_container--spread-single'),
        );
        const viewerRule = css.slice(
            css.indexOf('.pdfViewer {'),
            css.indexOf('.pdf-viewer-page-track {'),
        );

        expect(trackRule).toContain('box-sizing: border-box');
        expect(trackRule).toContain('width: 100%');
        expect(trackRule).toContain('min-width: 100%');
        expect(trackRule).toContain('min-height: 100%');
        expect(trackRule).toContain('display: flex');
        expect(trackRule).toContain('display: grid');
        expect(trackRule).toContain('grid-template-columns: repeat(2, max-content)');
        expect(trackRule).toContain('width: max-content');
        expect(trackRule).toContain('place-content: flex-start safe center');
        expect(css).toMatch(/\.pdf-viewer-page-track\.pdfViewer\.pdfViewer--mode-facing,[^{]+\{[^}]*width:\s*100%;/su);
        expect(viewerRule).not.toContain('display: flex');
        expect(viewerRule).not.toContain('display: grid');
    });

    it('applies the analytical 20px padding and row gap to that same track', () => {
        const viewport = read('app/modules/pdf-viewer/components/PdfViewerViewport.vue');
        const scale = read('app/modules/pdf-viewer/runtime/composables/pdf/usePdfScale.ts');

        expect(viewport).toContain(':style="containerStyle"');
        expect(viewport).toContain('getStyle: () => ({})');
        expect(scale).toContain('import { DOCUMENT_PAGE_GUTTER_PX } from \'@app/utils/document-viewer/layout/documentPageGutterPx\';');
        expect(scale).toContain('padding: `${DOCUMENT_PAGE_GUTTER_PX}px`');
        expect(scale).toContain('gap: `${DOCUMENT_PAGE_GUTTER_PX}px`');
    });

    it('atomically swaps the pending skeleton for the committed canvas', () => {
        const css = read('app/assets/css/pdf-viewer.scss');

        expect(css).toMatch(/\.page_container--rendered \.document-page-skeleton\s*\{[^}]*display:\s*none;/su);
        expect(css).toMatch(/\.page_container:not\(\.page_container--rendered\) \.page_canvas__render-layer\s*\{[^}]*visibility:\s*hidden;/su);
    });

    it('leaves the chassis viewport as the only overflow owner', () => {
        const chassis = read('app/modules/workspace-shell/components/DocumentViewerChassis.vue');
        const viewport = read('app/modules/pdf-viewer/components/PdfViewerViewport.vue');

        expect(chassis).toMatch(/\[data-document-viewer-chassis-viewport\]\s*\{[^}]*overflow:\s*auto;/su);
        expect(chassis).toMatch(/\[data-document-viewer-chassis-viewport\]\s*\{[^}]*display:\s*block;/su);
        expect(chassis).toMatch(/\[data-document-viewer-chassis-viewport\]\s*\{[^}]*padding:\s*0;/su);
        expect(chassis).toMatch(/\[data-document-viewer-chassis-viewport\]\s*\{[^}]*gap:\s*0;/su);
        expect(viewport).toContain('setViewerContainer(chassisAuthority?.viewportElement.value');
        expect(viewport).toContain('\'pdfViewer app-scrollbar app-scroll-region--balanced\'');
        expect(viewport).toContain('getStyle: () => ({})');
    });

});
