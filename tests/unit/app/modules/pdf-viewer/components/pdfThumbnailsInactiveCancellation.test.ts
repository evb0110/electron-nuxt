import { readFileSync } from 'node:fs';
import {
    dirname,
    resolve,
} from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    describe,
    expect,
    it,
} from 'vitest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../..');

function readPdfThumbnailsSource() {
    return readFileSync(
        resolve(repoRoot, 'app/modules/pdf-viewer/components/PdfThumbnails.vue'),
        'utf8',
    );
}

describe('PdfThumbnails inactive cancellation wiring', () => {
    it('cancels active render work and bumps generation when the pane becomes inactive', () => {
        const source = readPdfThumbnailsSource();
        const inactiveWatcher = source.match(/watch\(\s*\(\) => isActive \?\? true,[\s\S]*?\{[\s\S]*?flush: 'post'/u)?.[0] ?? '';

        expect(inactiveWatcher).toContain('cancelActivePaneRefresh();');
        expect(inactiveWatcher).toContain('cancelAllRenders();');
        expect(inactiveWatcher).toContain('renderRunId += 1;');
    });

    it('uses active-pane generation checks before queueing and starting thumbnail renders', () => {
        const source = readPdfThumbnailsSource();

        expect(source).toContain('isThumbnailRenderGenerationCurrent(pdfDocument, runId)');
        expect(source).toContain('shouldStart: isCurrentThumbnailRender');
        expect(source).toContain('shouldContinue: isCurrentThumbnailRender');
    });
});
