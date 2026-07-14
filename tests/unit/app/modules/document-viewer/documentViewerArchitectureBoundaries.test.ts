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
const read = (relativePath: string) => readFileSync(join(root, relativePath), 'utf8');

describe('document viewer architecture boundaries', () => {
    it('mounts exactly one source-neutral viewport outside feature packs', () => {
        const chassis = read('app/modules/workspace-shell/components/DocumentViewerChassis.vue');
        expect(chassis.match(/<DocumentViewportHost/gu)).toHaveLength(1);

        for (const path of [
            'app/modules/pdf-viewer/components/PdfViewerViewport.vue',
            'app/modules/native-pdf-viewer/components/NativePdfViewer.vue',
            'app/modules/workspace-shell/components/DocumentPageSourceFeaturePack.vue',
        ]) {
            expect(read(path), path).not.toContain('<DocumentViewportHost');
        }
    });

    it('keeps renderer pixel mutations behind the chassis write port', () => {
        for (const path of [
            'app/modules/native-pdf-viewer/components/NativePdfViewer.vue',
            'app/modules/workspace-shell/components/DocumentPageSourceFeaturePack.vue',
            'app/modules/pdf-viewer/runtime/composables/pdf/usePdfDrag.ts',
        ]) {
            const source = read(path);
            expect(source, path).not.toMatch(/\.scroll(?:Top|Left)\s*[-+]?=/u);
            expect(source, path).not.toMatch(/\.scrollTo\s*\(/u);
            expect(source, path).toContain('viewportWritePort');
        }
    });

    it('projects every renderer into the same viewport chrome', () => {
        const pdfViewport = read('app/modules/pdf-viewer/components/PdfViewerViewport.vue');
        const sourceFeature = read('app/modules/workspace-shell/components/DocumentPageSourceFeaturePack.vue');
        const sharedStyles = read('app/assets/css/main.css');

        expect(pdfViewport).toContain('document-viewer-viewport pdfViewer app-scrollbar');
        expect(sourceFeature).toContain('document-viewer-viewport document-source-viewer app-scrollbar');
        expect(sharedStyles).toMatch(
            /\.document-viewer-viewport\s*\{[^}]*background: var\(--app-document-viewer-bg\);/su,
        );
        expect(sourceFeature).not.toMatch(/--app-pdf-(?:viewer|page)/u);
        expect(read('app/modules/workspace-shell/components/DocumentViewerChassis.vue'))
            .not.toMatch(/--app-pdf-(?:viewer|page)/u);
    });

    it('treats tab transitions as semantic viewer layout resizes', () => {
        const workspace = read('app/modules/workspace-shell/components/DocumentWorkspace.vue');

        expect(workspace).toMatch(
            /isActiveViewerLayoutResizing\s*=\s*computed\(\(\)\s*=>\s*\([\s\S]*?isTabTransitionBusy[\s\S]*?\)\);/u,
        );
    });

    it('owns resize anchoring in the shared chassis with neutral page markers', () => {
        const chassis = read('app/modules/workspace-shell/components/DocumentViewerChassis.vue');
        const pdfPage = read('app/modules/pdf-viewer/components/PdfViewerPage.vue');
        const sourceFeature = read('app/modules/workspace-shell/components/DocumentPageSourceFeaturePack.vue');

        expect(chassis).toContain('captureDocumentViewportResizeAnchor');
        expect(chassis).toContain('chassisAuthority.viewportWritePort.apply');
        expect(pdfPage).toContain(':data-document-page-number="page"');
        expect(sourceFeature).toContain(':data-document-page-number="pageNumber"');
    });

    it('exposes one sidebar host contract for every document renderer', () => {
        const pdfSidebar = read('app/modules/pdf-viewer/components/PdfSidebar.vue');
        const sourceSidebar = read('app/modules/workspace-shell/components/DocumentSourceSidebar.vue');

        expect(pdfSidebar).toContain('data-testid="document-sidebar"');
        expect(sourceSidebar).toContain('data-testid="document-sidebar"');
    });

    it('advertises source search independently from page-text extraction', () => {
        const sourceFeature = read('app/modules/workspace-shell/components/DocumentPageSourceFeaturePack.vue');

        expect(sourceFeature).toContain(
            'search: Boolean(nextSource.searchProvider ?? nextSource.textProvider)',
        );
        expect(sourceFeature).toContain('text: Boolean(nextSource.textProvider)');
    });
});
