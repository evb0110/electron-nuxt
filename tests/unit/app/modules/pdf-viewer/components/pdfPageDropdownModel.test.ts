import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    getPdfPageDropdownIndicatorParts,
    getPdfPageDropdownInputLabel,
    resolvePdfPageDropdownDisplayPage,
    stepPdfPageDropdownCommand,
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
    it('composes five Next commands while metadata page count is unknown', () => {
        let commandPage = resolvePdfPageDropdownDisplayPage({
            currentPage: 1,
            navigationPage: 1,
            totalPages: 0,
        });

        for (let click = 0; click < 5; click += 1) {
            commandPage = stepPdfPageDropdownCommand(commandPage, 'single', 0, 1);
        }

        expect(commandPage).toBe(6);
        expect(resolvePdfPageDropdownDisplayPage({
            currentPage: 1,
            navigationPage: commandPage,
            totalPages: 0,
        })).toBe(6);
        expect(stepPdfPageDropdownCommand(commandPage, 'single', 0, -1)).toBe(5);
    });

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
