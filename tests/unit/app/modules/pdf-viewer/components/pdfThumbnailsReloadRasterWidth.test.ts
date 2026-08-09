import {readFileSync} from 'node:fs';
import {
    dirname,
    resolve,
} from 'node:path';
import {fileURLToPath} from 'node:url';
import {
    describe,
    expect,
    it,
} from 'vitest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../..');

describe('PDF thumbnail reload raster width', () => {
    it('re-seeds a source replacement from the measured rail width', () => {
        const source = readFileSync(
            resolve(
                repoRoot,
                'app/modules/pdf-viewer/thumbnails/usePdfThumbnailRenderRuntime.ts',
            ),
            'utf8',
        );
        const clearRenderedState = source.match(
            /function clearRenderedState\(clearLayout = true\)[\s\S]*?\n\s{4}\}\n\n\s{4}function invalidatePages/u,
        )?.[0] ?? '';

        expect(clearRenderedState).toContain(
            'resolveThumbnailRasterWidth(\n                layout.thumbnailLayoutWidth.value,\n            )',
        );
        expect(clearRenderedState).not.toContain('layout.thumbnailRenderWidth.value = THUMBNAIL_WIDTH');
    });
});
