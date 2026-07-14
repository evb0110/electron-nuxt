import fs from 'node:fs';
import path from 'node:path';
import {
    describe,
    expect,
    it,
} from 'vitest';

const root = process.cwd();
function read(relativePath: string) {
    return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

describe('document bookmark architecture boundaries', () => {
    it('uses the common bookmark presentation for PDF and page-source formats', () => {
        const pdfOutline = read('app/modules/pdf-viewer/components/PdfOutline.vue');
        const sourceSidebar = read('app/modules/workspace-shell/components/DocumentSourceSidebar.vue');

        for (const source of [
            pdfOutline,
            sourceSidebar,
        ]) {
            expect(source).toContain('DocumentBookmarkToolbar');
            expect(source).toContain('DocumentBookmarkTree');
        }
        expect(sourceSidebar).not.toContain('flattenDocumentOutline');
        expect(sourceSidebar).not.toContain('v-for="item in outlineItems"');
    });

    it('keeps PDF editing as an augmentation of the shared read-only tree', () => {
        const pdfOutline = read('app/modules/pdf-viewer/components/PdfOutline.vue');

        expect(pdfOutline).toContain('editable');
        expect(pdfOutline).toContain('v-else-if="isEditMode"');
        expect(pdfOutline).toContain('<DocumentBookmarkTree');
        expect(pdfOutline).toContain('<PdfOutlineItem');
    });
});
