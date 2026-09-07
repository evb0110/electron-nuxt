import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { requirePageNumber } from '@contracts/pageNumbers';
import { requireEpochMs } from '@contracts/timestamps';
import type { IPdfViewerEmit } from '@app/modules/pdf-viewer/runtime/contracts/pdfViewerComponent.types';
import { createPdfViewerEventAdapter } from '@app/modules/pdf-viewer/runtime/contracts/createPdfViewerEventAdapter';
import { createDiagnosticEventId } from '@contracts/diagnostics/diagnosticEventId';

describe('createPdfViewerEventAdapter', () => {
    it('forwards an annotation creation failure to the workspace verbatim', () => {
        const emit = vi.fn((_event: string, _payload?: unknown) => {});
        const typedEmit: IPdfViewerEmit = emit;
        const adapter = createPdfViewerEventAdapter(typedEmit);
        const failure = {
            kind: 'fault' as const,
            failure: {
                eventId: createDiagnosticEventId(),
                code: 'UNCLASSIFIED_RENDERER_ERROR' as const,
                occurredAt: requireEpochMs(1),
                severity: 'error' as const,
            },
            operationId: 'annotation-create-3',
            reason: 'mode-switch-failed' as const,
            pageNumber: requirePageNumber(4),
        };

        adapter.annotationFailure(failure);

        // The bridge renders no UI of its own, so a failure that is not
        // emitted here reaches nobody.
        expect(emit).toHaveBeenCalledExactlyOnceWith('annotation-failure', failure);
    });

    it('keeps the failure channel separate from the modified channel', () => {
        const emit = vi.fn((_event: string, _payload?: unknown) => {});
        const typedEmit: IPdfViewerEmit = emit;
        const adapter = createPdfViewerEventAdapter(typedEmit);

        adapter.annotationFailure({
            kind: 'expected',
            outcome: {
                kind: 'expected',
                code: 'validation-rejected',
            },
            operationId: 'annotation-create-1',
            reason: 'selection-spans-pages',
            pageNumber: null,
        });
        adapter.annotationModified();

        expect(emit.mock.calls.map(call => call[0])).toEqual([
            'annotation-failure',
            'annotation-modified',
        ]);
    });
});
