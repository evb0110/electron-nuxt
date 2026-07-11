import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    initialAnnotationSyncState,
    reduceAnnotationSync,
} from '@app/modules/pdf-viewer/annotations/sync/annotationSyncMachine';

interface IRecord {
    id: string;
    revision: number
}

function begin(generation: number) {
    return reduceAnnotationSync(initialAnnotationSyncState<IRecord>(), {
        type: 'begin',
        generation,
    });
}

describe('AnnotationSyncMachine adversarial event ordering', () => {
    it('ignores late snapshots and finish signals from an older generation', () => {
        let state = begin(4);
        state = reduceAnnotationSync(state, {
            type: 'receive-editor-snapshot',
            generation: 3,
            records: [{
                id: 'stale-editor',
                revision: 1,
            }],
        });
        state = reduceAnnotationSync(state, {
            type: 'receive-pdf-page',
            generation: 3,
            pageIndex: 0,
            records: [{
                id: 'stale-pdf',
                revision: 1,
            }],
        });
        state = reduceAnnotationSync(state, {
            type: 'finish-pdf-snapshot',
            generation: 3,
        });

        expect(state).toMatchObject({
            generation: 4,
            phase: 'collecting',
            editorRecords: [],
        });
        expect(state.pdfPages.size).toBe(0);
    });

    it('resets all generation-scoped collections on a newer begin', () => {
        let state = begin(8);
        state = reduceAnnotationSync(state, {
            type: 'receive-editor-snapshot',
            generation: 8,
            records: [{
                id: 'editor',
                revision: 1,
            }],
        });
        state = reduceAnnotationSync(state, {
            type: 'receive-pdf-page',
            generation: 8,
            pageIndex: 2,
            records: [{
                id: 'pdf',
                revision: 2,
            }],
        });
        state = reduceAnnotationSync(state, {
            type: 'editor-layer-rebuilt',
            generation: 8,
            pageIndex: 2,
        });
        state = reduceAnnotationSync(state, {
            type: 'suppress',
            generation: 8,
            token: 'local-command',
        });

        state = reduceAnnotationSync(state, {
            type: 'begin',
            generation: 9,
        });

        expect(state).toMatchObject({
            generation: 9,
            phase: 'collecting',
            editorRecords: [],
        });
        expect(state.pdfPages.size).toBe(0);
        expect(state.rebuiltPages.size).toBe(0);
        expect(state.suppressedTokens.size).toBe(0);
    });

    it('keeps the newest record set for each source regardless of arrival order', () => {
        let editorFirst = begin(11);
        editorFirst = reduceAnnotationSync(editorFirst, {
            type: 'receive-editor-snapshot',
            generation: 11,
            records: [{
                id: 'editor',
                revision: 2,
            }],
        });
        editorFirst = reduceAnnotationSync(editorFirst, {
            type: 'receive-pdf-page',
            generation: 11,
            pageIndex: 0,
            records: [{
                id: 'pdf',
                revision: 3,
            }],
        });

        let pdfFirst = begin(11);
        pdfFirst = reduceAnnotationSync(pdfFirst, {
            type: 'receive-pdf-page',
            generation: 11,
            pageIndex: 0,
            records: [{
                id: 'pdf',
                revision: 3,
            }],
        });
        pdfFirst = reduceAnnotationSync(pdfFirst, {
            type: 'receive-editor-snapshot',
            generation: 11,
            records: [{
                id: 'editor',
                revision: 2,
            }],
        });

        expect(pdfFirst.editorRecords).toEqual(editorFirst.editorRecords);
        expect(pdfFirst.pdfPages).toEqual(editorFirst.pdfPages);
    });

    it('freezes a completed snapshot against malformed same-generation late events', () => {
        let state = begin(14);
        state = reduceAnnotationSync(state, {
            type: 'receive-pdf-page',
            generation: 14,
            pageIndex: 0,
            records: [{
                id: 'accepted',
                revision: 1,
            }],
        });
        state = reduceAnnotationSync(state, {
            type: 'finish-pdf-snapshot',
            generation: 14,
        });
        const complete = state;

        state = reduceAnnotationSync(state, {
            type: 'receive-pdf-page',
            generation: 14,
            pageIndex: -1,
            records: [{
                id: 'late',
                revision: 99,
            }],
        });
        state = reduceAnnotationSync(state, {
            type: 'receive-editor-snapshot',
            generation: 14,
            records: [{
                id: 'late-editor',
                revision: 99,
            }],
        });

        expect(state).toBe(complete);
    });
});
