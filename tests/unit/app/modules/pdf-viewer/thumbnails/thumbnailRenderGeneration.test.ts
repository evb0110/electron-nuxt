import {
    describe,
    expect,
    it,
} from 'vitest';
import { isThumbnailRenderGenerationCurrent } from '@app/modules/pdf-viewer/thumbnails/isThumbnailRenderGenerationCurrent';

describe('isThumbnailRenderGenerationCurrent', () => {
    it('requires matching generation, a usable document, and an active pane', () => {
        const current = {
            runId: 3,
            renderRunId: 3,
            isDocumentUsable: true,
            isPaneActive: true,
        };

        expect(isThumbnailRenderGenerationCurrent(current)).toBe(true);
        expect(isThumbnailRenderGenerationCurrent({
            ...current,
            renderRunId: 4,
        })).toBe(false);
        expect(isThumbnailRenderGenerationCurrent({
            ...current,
            isDocumentUsable: false,
        })).toBe(false);
        expect(isThumbnailRenderGenerationCurrent({
            ...current,
            isPaneActive: false,
        })).toBe(false);
    });
});
