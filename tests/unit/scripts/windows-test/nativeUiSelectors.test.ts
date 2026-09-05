import {
    describe,
    expect,
    it,
} from 'vitest';
import selectorsFile from '@tests/windows/native-ui/selectors.json';
import {
    findSelectorRecord,
    isUiSelector,
    isUiSelectorRecord,
    isUiSelectorRecordFile,
    loadSelectorRecords,
    requireControlSelector,
    requireWindowQuery,
    uiSelectorSurfaces,
    unverifiedSelectorIds,
} from '@scripts/windows-test/guest/native-ui/selectorRecords';
import {
    escapeSendKeysText,
    nativeDialogRecordIds,
    modernNativeDialogRecordIds,
} from '@scripts/windows-test/guest/cases/nativeDialogs';

const records = loadSelectorRecords();

describe('native UI selector records', () => {
    it('loads the checked-in selector file', () => {
        expect(isUiSelectorRecordFile(selectorsFile)).toBe(true);
        expect(records.records.length).toBeGreaterThan(0);
    });

    it('gives every record a surface, a description and exactly one payload', () => {
        for (const record of records.records) {
            expect(uiSelectorSurfaces, record.id).toContain(record.surface);
            expect(record.description.length, record.id).toBeGreaterThan(10);
            if (record.kind === 'window') {
                expect(record.window, record.id).toBeDefined();
                expect(record.selector, record.id).toBeUndefined();
            } else {
                expect(record.selector, record.id).toBeDefined();
                expect(record.window, record.id).toBeUndefined();
            }
        }
    });

    it('uses unique ids', () => {
        const ids = records.records.map(record => record.id);
        expect(new Set(ids).size).toBe(ids.length);
    });

    it('records only the modern print mappings proven on the named image', () => {
        expect(records.records.filter(record => record.verified).map(record => record.id)).toEqual([
            modernNativeDialogRecordIds.printDialog,
            modernNativeDialogRecordIds.printerList,
            modernNativeDialogRecordIds.printButton,
        ]);
        for (const record of records.records) {
            if (record.verified) {
                expect(record.verifiedOnImage, record.id).toBe('evb-win11-arm64-lab-20260905');
            } else {
                expect(record.verifiedOnImage, record.id).toBeNull();
            }
        }
        expect(unverifiedSelectorIds(records)).toEqual(records.records
            .filter(record => !record.verified)
            .map(record => record.id));
    });

    it('carries localized fallbacks on the dialog buttons a Russian or German guest renames', () => {
        const commit = requireControlSelector(records, nativeDialogRecordIds.commitButton);
        expect(commit.name?.localizedFallbacks?.length ?? 0).toBeGreaterThan(0);
        const cancel = requireControlSelector(records, nativeDialogRecordIds.cancelButton);
        expect(cancel.name?.localizedFallbacks?.length ?? 0).toBeGreaterThan(0);
    });

    it('backs every dialog step the cases perform with a record', () => {
        for (const recordId of Object.values(nativeDialogRecordIds)) {
            expect(() => findSelectorRecord(records, recordId), recordId).not.toThrow();
        }
        for (const recordId of Object.values(modernNativeDialogRecordIds)) {
            expect(() => findSelectorRecord(records, recordId), recordId).not.toThrow();
        }
    });

    it('matches the captured modern print tree without weakening legacy selectors', () => {
        expect(requireWindowQuery(records, modernNativeDialogRecordIds.printDialog)).toEqual({
            className: 'ApplicationFrameWindow',
            titleContains: 'EVB Viewer - Print',
        });
        expect(requireControlSelector(records, modernNativeDialogRecordIds.printerList)).toEqual({
            automationId: 'printerSelector',
            controlType: 'ComboBox',
            name: { exact: 'Printer' },
        });
        expect(requireControlSelector(records, modernNativeDialogRecordIds.printButton)).toEqual({
            automationId: 'PrintButton',
            controlType: 'Button',
            name: { exact: 'Print' },
        });
        expect(requireWindowQuery(records, nativeDialogRecordIds.printDialog)).toEqual({
            className: '#32770',
            titleContains: 'Print',
        });
    });

    it('refuses an unknown id and a payload of the wrong kind', () => {
        expect(() => findSelectorRecord(records, 'nope')).toThrow('Unknown native UI selector record');
        expect(() => requireControlSelector(records, nativeDialogRecordIds.fileDialog))
            .toThrow('does not describe a control');
        expect(() => requireWindowQuery(records, nativeDialogRecordIds.commitButton))
            .toThrow('does not describe a window');
    });

    it('rejects malformed record files instead of loading them', () => {
        expect(() => loadSelectorRecords({ schemaVersion: 2 })).toThrow('is not a valid selector record file');
        expect(isUiSelectorRecordFile({
            schemaVersion: 1,
            note: 'x',
            records: [],
        })).toBe(false);
        expect(isUiSelectorRecord({
            id: 'a',
            surface: 'unknown-surface',
            kind: 'control',
            description: 'x',
            selector: { controlType: 'Button' },
            verified: false,
            verifiedOnImage: null,
        })).toBe(false);
        expect(isUiSelector({ controlType: '' })).toBe(false);
    });

    it('rejects a record file with duplicate ids', () => {
        const first = records.records[0];
        expect(first).toBeDefined();
        expect(isUiSelectorRecordFile({
            schemaVersion: 1,
            note: 'duplicate',
            records: [
                first,
                first,
            ],
        })).toBe(false);
    });

    it('escapes every SendKeys control character so a typed path arrives literally', () => {
        expect(escapeSendKeysText('C:\\Users\\a (1)\\b+c{d}~e%f^g[h].pdf'))
            .toBe('C:\\Users\\a {(}1{)}\\b{+}c{{}d{}}{~}e{%}f{^}g{[}h{]}.pdf');
        expect(escapeSendKeysText('C:\\plain\\unicode-Тест.pdf')).toBe('C:\\plain\\unicode-Тест.pdf');
    });
});
