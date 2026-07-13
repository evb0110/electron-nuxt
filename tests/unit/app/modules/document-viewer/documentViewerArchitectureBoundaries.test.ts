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
});
