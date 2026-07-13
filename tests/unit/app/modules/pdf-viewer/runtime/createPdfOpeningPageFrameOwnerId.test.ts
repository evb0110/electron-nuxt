import {
    describe,
    expect,
    it,
} from 'vitest';
import { createPdfOpeningPageFrameOwnerId } from '@app/modules/pdf-viewer/runtime/lifecycle/createPdfOpeningPageFrameOwnerId';

describe('createPdfOpeningPageFrameOwnerId', () => {
    it('gives every mounted PDF viewer a distinct frame owner', () => {
        const first = createPdfOpeningPageFrameOwnerId();
        const second = createPdfOpeningPageFrameOwnerId();

        expect(first).toMatch(/^pdfjs:\d+$/u);
        expect(second).toMatch(/^pdfjs:\d+$/u);
        expect(second).not.toBe(first);
    });
});
