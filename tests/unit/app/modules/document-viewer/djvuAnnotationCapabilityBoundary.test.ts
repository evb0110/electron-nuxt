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

describe('DjVu annotation capability boundary', () => {
    it('does not advertise the removed local-only annotation prototype', () => {
        const source = read('app/utils/document-viewer/source/createDjvuPageSource.ts');
        const sourceSidebar = read('app/modules/workspace-shell/components/DocumentSourceSidebar.vue');
        const featurePack = read('app/modules/workspace-shell/components/DocumentPageSourceFeaturePack.vue');

        expect(source).not.toContain('annotationProvider');
        expect(sourceSidebar).toContain('annotations: false');
        expect(sourceSidebar).not.toContain('addNote');
        expect(sourceSidebar).not.toContain('annotations-changed');
        expect(featurePack).not.toContain('document-source-viewer__annotation');
    });

    it('keeps PDF as the explicit annotation-capable format', () => {
        const pdfSidebar = read('app/modules/pdf-viewer/components/PdfSidebar.vue');
        const sourceSidebar = read('app/modules/workspace-shell/components/DocumentSourceSidebar.vue');

        expect(pdfSidebar).toContain('<PdfAnnotationsPanel');
        expect(sourceSidebar).not.toContain('AnnotationsPanel');
    });
});
