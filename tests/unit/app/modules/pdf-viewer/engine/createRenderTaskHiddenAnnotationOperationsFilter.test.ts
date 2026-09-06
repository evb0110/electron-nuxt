import {
    describe,
    expect,
    it,
} from 'vitest';
import { createRenderTaskHiddenAnnotationOperationsFilter } from '@app/modules/pdf-viewer/engine/pdf-hidden-annotation-operations/createRenderTaskHiddenAnnotationOperationsFilter';

function createTask(fnArray: number[], argsArray: unknown[]) {
    // The filter reads only PDF.js's private operator-list slot. Keep that
    // deliberate private-shape shim in this local fixture builder.
    return Object.assign(Object.create(null), {_internalRenderTask: {operatorList: {
        fnArray,
        argsArray,
    }}});
}

function createUnsupportedTask() {
    // This case proves the runtime guard rejects a task without the private
    // PDF.js operator-list shape.
    return Object.create(null);
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
        expect(runtime.bindTask(createUnsupportedTask())).toBe(false);
    });

    it('keeps every operator when the bound page carries no annotation boundaries', () => {
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
    });

    it('keeps filtering after pdf.js appends further operator-list chunks in place', () => {
        const runtime = createRenderTaskHiddenAnnotationOperationsFilter(new Set(['12R']));
        const fnArray = [10];
        const argsArray: unknown[] = [[]];
        expect(runtime.bindTask(createTask(fnArray, argsArray))).toBe(true);
        expect(runtime.filter(0)).toBe(true);

        fnArray.push(80, 20, 81);
        argsArray.push(['12R'], [], []);

        expect([
            runtime.filter(1),
            runtime.filter(2),
            runtime.filter(3),
        ]).toEqual([
            false,
            false,
            false,
        ]);
    });
});
