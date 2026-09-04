import {
    isRecord,
    isStringArray,
} from '@contracts/runtimeGuards';
import selectorRecordsFile from '@tests/windows/native-ui/selectors.json';
import type {
    IUiSelector,
    IUiWindowQuery,
} from '@scripts/windows-test/guest/native-ui/nativeUiAdapter';

export const MICROSOFT_PRINT_TO_PDF_PRINTER = 'Microsoft Print to PDF';

export const uiSelectorSurfaces = [
    'evb-viewer',
    'common-file-dialog',
    'print-dialog',
] as const;

export type TUiSelectorSurface = typeof uiSelectorSurfaces[number];

export interface IUiSelectorRecord {
    id: string;
    surface: TUiSelectorSurface;
    kind: 'window' | 'control';
    description: string;
    selector?: IUiSelector;
    window?: IUiWindowQuery;
    verified: boolean;
    verifiedOnImage: string | null;
}

export interface IUiSelectorRecordFile {
    schemaVersion: 1;
    note: string;
    records: IUiSelectorRecord[];
}

function isSelectorName(value: unknown) {
    if (!isRecord(value)) {
        return false;
    }
    const exactValid = value.exact === undefined || typeof value.exact === 'string';
    const fallbacksValid = value.localizedFallbacks === undefined || isStringArray(value.localizedFallbacks);
    return exactValid && fallbacksValid;
}

export function isUiSelector(value: unknown): value is IUiSelector {
    return isRecord(value)
        && typeof value.controlType === 'string'
        && value.controlType.length > 0
        && (value.automationId === undefined || typeof value.automationId === 'string')
        && (value.name === undefined || isSelectorName(value.name))
        && (value.processId === undefined || typeof value.processId === 'number')
        && (value.index === undefined || typeof value.index === 'number');
}

export function isUiWindowQuery(value: unknown): value is IUiWindowQuery {
    return isRecord(value)
        && (value.titleContains === undefined || typeof value.titleContains === 'string')
        && (value.automationId === undefined || typeof value.automationId === 'string')
        && (value.className === undefined || typeof value.className === 'string')
        && (value.processId === undefined || typeof value.processId === 'number');
}

export function isUiSelectorRecord(value: unknown): value is IUiSelectorRecord {
    if (!isRecord(value)) {
        return false;
    }
    const kindValid = value.kind === 'window' || value.kind === 'control';
    const payloadValid = value.kind === 'window'
        ? isUiWindowQuery(value.window) && value.selector === undefined
        : isUiSelector(value.selector) && value.window === undefined;
    return typeof value.id === 'string'
        && value.id.length > 0
        && (uiSelectorSurfaces as readonly string[]).includes(String(value.surface))
        && kindValid
        && typeof value.description === 'string'
        && value.description.length > 0
        && payloadValid
        && typeof value.verified === 'boolean'
        && (value.verifiedOnImage === null || typeof value.verifiedOnImage === 'string');
}

export function isUiSelectorRecordFile(value: unknown): value is IUiSelectorRecordFile {
    if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.note !== 'string') {
        return false;
    }
    if (!Array.isArray(value.records) || value.records.length === 0 || !value.records.every(isUiSelectorRecord)) {
        return false;
    }
    const ids = value.records.map(record => record.id);
    return new Set(ids).size === ids.length;
}

export function loadSelectorRecords(source: unknown = selectorRecordsFile): IUiSelectorRecordFile {
    if (!isUiSelectorRecordFile(source)) {
        throw new Error('tests/windows/native-ui/selectors.json is not a valid selector record file');
    }
    return source;
}

export function findSelectorRecord(file: IUiSelectorRecordFile, id: string) {
    const record = file.records.find(candidate => candidate.id === id);
    if (record === undefined) {
        throw new Error(`Unknown native UI selector record: ${id}`);
    }
    return record;
}

export function requireControlSelector(file: IUiSelectorRecordFile, id: string) {
    const record = findSelectorRecord(file, id);
    if (record.selector === undefined) {
        throw new Error(`Selector record ${id} does not describe a control`);
    }
    return record.selector;
}

export function requireWindowQuery(file: IUiSelectorRecordFile, id: string) {
    const record = findSelectorRecord(file, id);
    if (record.window === undefined) {
        throw new Error(`Selector record ${id} does not describe a window`);
    }
    return record.window;
}

export function unverifiedSelectorIds(file: IUiSelectorRecordFile) {
    return file.records.filter(record => !record.verified).map(record => record.id);
}
