import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { createPagePreviewCache } from '@app/modules/pdf-viewer/engine/pdf-page-preview/createPagePreviewCache';
import { cast } from '@tests/helpers/cast';

describe('createPagePreviewCache', () => {
    it('evicts the least recently used preview and closes its source', () => {
        const firstSource = cast<ImageBitmap>({
            width: 10,
            height: 10,
            close: vi.fn(),
        });
        const secondSource = cast<ImageBitmap>({
            width: 10,
            height: 10,
            close: vi.fn(),
        });
        const thirdSource = cast<ImageBitmap>({
            width: 10,
            height: 10,
            close: vi.fn(),
        });
        const cache = createPagePreviewCache({ maxEntries: 2 });

        cache.set({
            pageNumber: 1,
            source: firstSource,
            width: 10,
            height: 10,
            generation: 0,
        });
        cache.set({
            pageNumber: 2,
            source: secondSource,
            width: 10,
            height: 10,
            generation: 0,
        });
        expect(cache.get(1, 0)?.pageNumber).toBe(1);
        cache.set({
            pageNumber: 3,
            source: thirdSource,
            width: 10,
            height: 10,
            generation: 0,
        });

        expect(firstSource.close).not.toHaveBeenCalled();
        expect(secondSource.close).toHaveBeenCalledTimes(1);
        expect(cache.get(1, 0)?.pageNumber).toBe(1);
        expect(cache.get(2, 0)).toBeNull();
        expect(cache.get(3, 0)?.pageNumber).toBe(3);
    });

    it('drops stale-generation previews on read', () => {
        const source = cast<ImageBitmap>({
            width: 10,
            height: 10,
            close: vi.fn(),
        });
        const cache = createPagePreviewCache({ maxEntries: 2 });

        cache.set({
            pageNumber: 1,
            source,
            width: 10,
            height: 10,
            generation: 4,
        });

        expect(cache.get(1, 5)).toBeNull();
        expect(source.close).toHaveBeenCalledTimes(1);
        expect(cache.size()).toBe(0);
    });
});
