import {
    describe,
    expect,
    it,
} from 'vitest';
import { resolveThumbnailRenderConcurrency } from '@app/modules/pdf-viewer/thumbnails/resolveThumbnailRenderConcurrency';

describe('resolveThumbnailRenderConcurrency', () => {
    it('uses one thumbnail worker during the navigation cooldown', () => {
        expect(resolveThumbnailRenderConcurrency({
            baseConcurrency: 2,
            lastNavigationAtMs: 1_000,
            navigationCooldownMs: 250,
            nowMs: 1_100,
        })).toBe(1);
    });

    it('restores the base concurrency after navigation settles', () => {
        expect(resolveThumbnailRenderConcurrency({
            baseConcurrency: 2,
            lastNavigationAtMs: 1_000,
            navigationCooldownMs: 250,
            nowMs: 1_300,
        })).toBe(2);
    });

    it('keeps at least one worker for invalid base values', () => {
        expect(resolveThumbnailRenderConcurrency({
            baseConcurrency: 0,
            lastNavigationAtMs: Number.NEGATIVE_INFINITY,
            navigationCooldownMs: 250,
            nowMs: 1_300,
        })).toBe(1);
    });
});
