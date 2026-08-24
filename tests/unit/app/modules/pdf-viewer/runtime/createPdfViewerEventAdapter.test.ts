import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { cast } from '@tests/helpers/cast';
import type { IPdfViewerEmit } from '@app/modules/pdf-viewer/runtime/contracts/pdfViewerComponent.types';
import { createPdfViewerEventAdapter } from '@app/modules/pdf-viewer/runtime/contracts/createPdfViewerEventAdapter';

describe('createPdfViewerEventAdapter', () => {
    it('forwards an annotation creation failure to the workspace verbatim', () => {
        const emit = vi.fn();
        const adapter = createPdfViewerEventAdapter(cast<IPdfViewerEmit>(emit));
        const failure = {
            operationId: 'annotation-create-3',
            reason: 'mode-switch-failed' as const,
            pageNumber: 4,
        };

        adapter.annotationFailure(failure);

        // The bridge renders no UI of its own, so a failure that is not
        // emitted here reaches nobody.
        expect(emit).toHaveBeenCalledExactlyOnceWith('annotation-failure', failure);
    });

    it('keeps the failure channel separate from the modified channel', () => {
        const emit = vi.fn();
        const adapter = createPdfViewerEventAdapter(cast<IPdfViewerEmit>(emit));

        adapter.annotationFailure({
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
