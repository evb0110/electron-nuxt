import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    getPdfPageDropdownIndicatorParts,
    getPdfPageDropdownInputLabel,
    resolvePdfPageDropdownDisplayPage,
} from '@app/modules/pdf-viewer/engine/pdfPageDropdownModel';

function createPageLabels() {
    return Array.from({length: 584}, (_, index) => {
        if (index === 0) {
            return 'Cover';
        }
        if (index === 34) {
            return '10';
        }
        return String(index + 1);
    });
}

describe('pdfPageDropdownModel', () => {
    it('resolves the pending navigation page for display instead of the old current page', () => {
        const page = resolvePdfPageDropdownDisplayPage({
            currentPage: 1,
            navigationPage: 35,
            totalPages: 584,
        });

        expect(page).toBe(35);
        expect(getPdfPageDropdownIndicatorParts({
            page,
            pageLabels: createPageLabels(),
            totalPages: 584,
        })).toEqual({
            primary: '10',
            secondary: '(35)',
        });
    });

    it('falls back to the current page when there is no navigation target', () => {
        const page = resolvePdfPageDropdownDisplayPage({
            currentPage: 1,
            totalPages: 584,
        });

        expect(page).toBe(1);
        expect(getPdfPageDropdownInputLabel(page, createPageLabels())).toBe('Cover');
    });
});
