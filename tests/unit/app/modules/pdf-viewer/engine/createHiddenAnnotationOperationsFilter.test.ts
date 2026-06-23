import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type { PDFPageProxy } from 'pdfjs-dist';
import { createHiddenAnnotationOperationsFilter } from '@app/modules/pdf-viewer/engine/pdf-hidden-annotation-operations/createHiddenAnnotationOperationsFilter';
import { cast } from '@tests/helpers/cast';

function createOperatorList() {
    return {
        fnArray: [80],
        argsArray: [['12R']],
    };
}

describe('createHiddenAnnotationOperationsFilter', () => {
    it('does not start the coordinated operator-list scan when the render is stale', async () => {
        const getOperatorList = vi.fn(async () => createOperatorList());
        const filter = await createHiddenAnnotationOperationsFilter(
            cast<PDFPageProxy>({
                pageNumber: 1,
                getOperatorList,
            }),
            1,
            new Set(['12R']),
            {
                owner: 'viewer',
                priority: 100,
                shouldStart: () => false,
            },
        );

        expect(filter).toBeUndefined();
        expect(getOperatorList).not.toHaveBeenCalled();
    });

    it('drops a coordinated operator-list result when the render goes stale before completion', async () => {
        const getOperatorList = vi.fn(async () => createOperatorList());
        const filter = await createHiddenAnnotationOperationsFilter(
            cast<PDFPageProxy>({
                pageNumber: 1,
                getOperatorList,
            }),
            1,
            new Set(['12R']),
            {
                owner: 'viewer',
                priority: 100,
                shouldContinue: () => false,
            },
        );

        expect(filter).toBeUndefined();
        expect(getOperatorList).toHaveBeenCalledOnce();
    });
});
