import {
    readdirSync,
    readFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
    describe,
    expect,
    it,
} from 'vitest';

const PDF_VIEWER_ROOT = join(process.cwd(), 'app/modules/pdf-viewer');

function collectProductionFiles(directory: string): string[] {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const path = join(directory, entry.name);
        return entry.isDirectory()
            ? collectProductionFiles(path)
            : /\.(?:ts|vue)$/.test(entry.name) ? [path] : [];
    });
}

function relativePath(path: string) {
    return path.slice(PDF_VIEWER_ROOT.length + 1);
}

describe('PDF viewport ownership boundary', () => {
    const files = collectProductionFiles(PDF_VIEWER_ROOT);

    it('keeps pixel viewport writes behind the write port', () => {
        const allowed = new Set([
            'runtime/viewport/pdfViewportWritePort.ts',
            // Thumbnail navigation owns its independent sidebar viewport.
            'components/PdfThumbnails.vue',
            // The annotation comments list owns its own virtualized sidebar
            // viewport: its scroll offset addresses comment rows, not document
            // pixels, and it rescales that offset when the row stride changes.
            'components/PdfAnnotationCommentsList.vue',
        ]);
        const violations = files.flatMap((path) => {
            if (allowed.has(relativePath(path))) {
                return [];
            }
            return /\.scroll(?:Top|Left)\s*=(?!=)/.test(readFileSync(path, 'utf8'))
                ? [relativePath(path)]
                : [];
        });
        expect(violations).toEqual([]);
    });

    it('keeps current-page writes in authority and native sensor projections', () => {
        const violations: string[] = [];
        for (const path of files) {
            const relative = relativePath(path);
            const count = readFileSync(path, 'utf8').match(/(?:options\.)?currentPage\.value\s*=(?!=)/g)?.length ?? 0;
            if (count !== 0) violations.push(`${relative}: found ${count}`);
        }
        expect(violations).toEqual([]);
    });

    it('uses positive live revisions and exposes no legacy viewport writers', () => {
        const violations = files.flatMap((path) => {
            const relative = relativePath(path);
            const source = readFileSync(path, 'utf8');
            if (/(?:document|geometry)Revision:\s*0\b/.test(source)) {
                return [relative];
            }
            if (relative === 'runtime/navigation/usePdfSinglePageNavigationController.ts'
                && /\.\.\.compatibility\b|suppressSnapFor|releasePagedNavigationHoldForPage|scrollToPageInternal/.test(source)) {
                return [relative];
            }
            return [];
        });
        expect(violations).toEqual([]);
    });

    it('does not reintroduce pixel snapshot restoration', () => {
        const forbidden = /captureScrollSnapshot|restoreScrollFromSnapshot|IScrollSnapshot|anchorSnapshot|snapshotToRestore|scrollSnapshot/;
        const violations = files.flatMap((path) => (
            forbidden.test(readFileSync(path, 'utf8')) ? [relativePath(path)] : []
        ));
        expect(violations).toEqual([]);
    });
});
