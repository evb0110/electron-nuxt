import {
    describe,
    expect,
    it,
} from 'vitest';
import type { RenderTask } from 'pdfjs-dist';
import { createRenderTaskHiddenAnnotationOperationsFilter } from '@app/modules/pdf-viewer/engine/pdf-hidden-annotation-operations/createRenderTaskHiddenAnnotationOperationsFilter';
import { cast } from '@tests/helpers/cast';

function createTask(fnArray: number[], argsArray: unknown[]) {
    return cast<RenderTask>({_internalRenderTask: {operatorList: {
        fnArray,
        argsArray,
    }}});
}

describe('createRenderTaskHiddenAnnotationOperationsFilter', () => {
    it('filters in the optimized render-task index space and preserves unrelated annotations', () => {
        const runtime = createRenderTaskHiddenAnnotationOperationsFilter(new Set(['12R']));
        expect(runtime.bindTask(createTask(
            [
                10,
                80,
                20,
                81,
                30,
                80,
                40,
                81,
            ],
            [
                [],
                ['12R'],
                [],
                [],
                [],
                ['13R'],
                [],
                [],
            ],
        ))).toBe(true);

        expect(Array.from({length: 8}, (_, index) => runtime.filter(index))).toEqual([
            true,
            false,
            false,
            false,
            true,
            true,
            true,
            true,
        ]);
    });

    it('reports an unsupported private render-task shape for narrow caller fallback', () => {
        const runtime = createRenderTaskHiddenAnnotationOperationsFilter(new Set(['12R']));
        expect(runtime.bindTask(cast<RenderTask>({}))).toBe(false);
    });

    it('reports optimized lists that flattened annotation boundaries for caller fallback', () => {
        const runtime = createRenderTaskHiddenAnnotationOperationsFilter(new Set(['12R']));
        expect(runtime.bindTask(createTask([
            10,
            20,
        ], [
            [],
            [],
        ]))).toBe(true);

        expect(runtime.filter(0)).toBe(true);
        expect(runtime.filter(1)).toBe(true);
        expect(runtime.getDiagnostics()).toMatchObject({
            callCount: 2,
            hiddenMatchCount: 0,
            hiddenAnnotationIds: ['12R'],
            seenAnnotationIds: [],
        });
    });
});
