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

describe('PdfThumbnails inactive cancellation lifecycle', () => {
    it('cancels the shared thumbnail demand source when the pane becomes inactive', () => {
        const source = readFileSync(
            resolve(
                repoRoot,
                'app/modules/pdf-viewer/thumbnails/usePdfThumbnailRenderRuntime.ts',
            ),
            'utf8',
        );
        const inactiveWatcher = source.match(
            /watch\(\s*\(\) => source\.isActive\.value,[\s\S]*?\{[\s\S]*?flush: 'post'/u,
        )?.[0] ?? '';

        expect(inactiveWatcher).toContain('effects.cancelActivePaneRefresh();');
        expect(inactiveWatcher).toContain(
            'activeScheduler?.cancelSource(THUMBNAIL_RASTER_SOURCE_ID)',
        );
        expect(inactiveWatcher).toContain('visibleThumbnailRenderScheduler.cancel();');
    });
});
