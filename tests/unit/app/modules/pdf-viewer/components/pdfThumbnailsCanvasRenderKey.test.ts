import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    describe,
    expect,
    it,
} from 'vitest';

describe('PdfThumbnails canvas render key', () => {
    it('keeps thumbnail canvases mounted and leaves render-key ownership with the runtime', () => {
        const source = readFileSync(
            join(process.cwd(), 'app/modules/pdf-viewer/components/PdfThumbnails.vue'),
            'utf8',
        );
        const canvasMatch = source.match(/<canvas[\s\S]*?class="pdf-thumbnail-canvas"[\s\S]*?\/>/);

        expect(canvasMatch?.[0]).not.toContain('data-thumbnail-render-key');
        expect(canvasMatch?.[0]).not.toContain(':key="getThumbnailRenderKey(page)"');
    });

    it('restores the visible anchor before an unchanged canvas can become pressure-evictable', () => {
        const source = readFileSync(
            join(process.cwd(), 'app/modules/pdf-viewer/components/PdfThumbnails.vue'),
            'utf8',
        );
        const reaction = source.match(
            /function scheduleThumbnailLayoutReaction\([\s\S]*?\n}\n/,
        )?.[0];

        expect(reaction).toBeDefined();
        expect(reaction).toContain('restoreThumbnailLayoutAnchor');
        expect(reaction).toContain('void nextTick');
        expect(reaction?.indexOf('restoreThumbnailLayoutAnchor')).toBeLessThan(
            reaction?.indexOf('void nextTick') ?? -1,
        );
    });
});
