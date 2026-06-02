import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { usePdfRendererCanvasController } from '@app/modules/pdf-viewer/runtime/rendering/usePdfRendererCanvasController';

describe('usePdfRendererCanvasController', () => {
    it('cancels an existing same-page PDF.js task before starting its replacement', async () => {
        const events: string[] = [];
        const previousTask = {
            cancel: vi.fn(() => {
                events.push('cancel previous');
            }),
            promise: new Promise(() => undefined),
        };
        const nextTask = {
            cancel: vi.fn(),
            promise: Promise.resolve(),
        };
        const activeRenderTasks = new Map([[
            928,
            {
                version: 5,
                requestId: 143,
                task: previousTask,
            },
        ]]);
        const cancelActiveRenderTask = vi.fn((pageNumber: number) => {
            const activeTask = activeRenderTasks.get(pageNumber);
            activeRenderTasks.delete(pageNumber);
            activeTask?.task.cancel();
        });
        const controller = usePdfRendererCanvasController({
            canvasRenderer: {
                prepareCanvasRender: vi.fn(),
                renderCanvas: vi.fn(),
                cleanupCanvas: vi.fn(),
                cleanupCanvasRenderResult: vi.fn(),
                applyContainerDimensions: vi.fn(),
                mountCanvas: vi.fn(),
            },
            activeRenderTasks,
            pageCanvases: new Map(),
            hiddenAnnotationIds: () => undefined,
            getRenderVersion: () => 5,
            getPage: vi.fn(),
            cancelActiveRenderTask,
            cancelActiveRenderTaskIfCurrent: vi.fn(),
        });
        const preparedCanvasRender = {
            canvas: {} as HTMLCanvasElement,
            viewport: {} as never,
            annotationCanvasMap: new Map<string, HTMLCanvasElement>(),
            scaleX: 1,
            scaleY: 1,
            rawDims: {
                pageWidth: 1,
                pageHeight: 1,
            },
            userUnit: 1,
            totalScaleFactor: 1,
            startRender: vi.fn(() => {
                events.push('start replacement');
                return nextTask;
            }),
        };

        await controller.renderPreparedCanvasResult(
            928,
            5,
            144,
            preparedCanvasRender,
            () => true,
        );

        expect(events).toEqual([
            'cancel previous',
            'start replacement',
        ]);
        expect(cancelActiveRenderTask).toHaveBeenCalledWith(928);
        expect(activeRenderTasks.get(928)?.task).toBe(nextTask);
    });
});
