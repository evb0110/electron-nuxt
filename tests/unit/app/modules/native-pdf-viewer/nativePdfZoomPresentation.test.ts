import {
    describe,
    expect,
    it,
} from 'vitest';
import { resolveDocumentPageDisplayScale } from '@app/utils/document-viewer/layout/resolveDocumentPageDisplayLayout';

const pageSize = {
    height: 1_000,
    width: 800,
};

describe('native PDF zoom presentation', () => {
    it('resolves custom and fit scales from one page presentation policy', () => {
        expect(resolveDocumentPageDisplayScale({
            availableHeight: 500,
            availableWidth: 600,
            manualZoom: 1.25,
            pageSize,
            zoomMode: 'custom',
        })).toBe(1.25);
        expect(resolveDocumentPageDisplayScale({
            availableHeight: 500,
            availableWidth: 600,
            manualZoom: 1,
            pageSize,
            zoomMode: 'fit-width',
        })).toBe(0.75);
        expect(resolveDocumentPageDisplayScale({
            availableHeight: 500,
            availableWidth: 600,
            manualZoom: 1,
            pageSize,
            zoomMode: 'fit-height',
        })).toBe(0.5);
    });

    it('falls back to clamped manual zoom when page geometry is unavailable', () => {
        expect(resolveDocumentPageDisplayScale({
            availableHeight: 500,
            availableWidth: 600,
            manualZoom: 1.5,
            pageSize: null,
            zoomMode: 'fit-width',
        })).toBe(1.5);
    });
});
