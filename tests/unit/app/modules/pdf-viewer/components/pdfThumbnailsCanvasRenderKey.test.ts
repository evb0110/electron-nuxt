import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    describe,
    expect,
    it,
} from 'vitest';

describe('PdfThumbnails canvas render key', () => {
    it('keeps thumbnail canvases mounted while render keys update', () => {
        const source = readFileSync(
            join(process.cwd(), 'app/modules/pdf-viewer/components/PdfThumbnails.vue'),
            'utf8',
        );
        const canvasMatch = source.match(/<canvas[\s\S]*?class="pdf-thumbnail-canvas"[\s\S]*?\/>/);

        expect(canvasMatch?.[0]).toContain(':data-thumbnail-render-key="getThumbnailRenderKey(page)"');
        expect(canvasMatch?.[0]).not.toContain(':key="getThumbnailRenderKey(page)"');
    });
});
