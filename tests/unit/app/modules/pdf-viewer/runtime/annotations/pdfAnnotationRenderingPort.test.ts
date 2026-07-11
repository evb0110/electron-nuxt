import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {createAttachablePdfAnnotationRenderingPort} from '@app/modules/pdf-viewer/runtime/annotations/createAttachablePdfAnnotationRenderingPort';

describe('pdfAnnotationRenderingPort', () => {
    it('fails explicitly when rendering is requested before attachment', () => {
        const { port } = createAttachablePdfAnnotationRenderingPort();

        expect(() => port.renderVisiblePages({
            start: 1,
            end: 1,
        })).toThrow(
            'PDF annotation rendering port has not been attached',
        );
        expect(() => port.isPageRendered(1)).toThrow(
            'PDF annotation rendering port has not been attached',
        );
    });

    it('delegates every rendering capability after attachment', async () => {
        const renderVisiblePages = vi.fn(async () => {});
        const renderAnnotationEditorLayerForPage = vi.fn(async () => true);
        const isPageRendered = vi.fn(() => true);
        const invalidatePages = vi.fn();
        const hideManagedAnnotationEditors = vi.fn();
        const {
            port,
            attachRenderingPort,
        } = createAttachablePdfAnnotationRenderingPort();
        attachRenderingPort({
            renderVisiblePages,
            renderAnnotationEditorLayerForPage,
            isPageRendered,
            invalidatePages,
            hideManagedAnnotationEditors,
        });

        await port.renderVisiblePages(
            {
                start: 2,
                end: 3,
            },
            { forceRerender: true },
        );
        await expect(port.renderAnnotationEditorLayerForPage(2)).resolves.toBe(true);
        expect(port.isPageRendered(3)).toBe(true);
        port.invalidatePages([
            2,
            3,
        ]);
        port.hideManagedAnnotationEditors(2);

        expect(renderVisiblePages).toHaveBeenCalledWith(
            {
                start: 2,
                end: 3,
            },
            { forceRerender: true },
        );
        expect(renderAnnotationEditorLayerForPage).toHaveBeenCalledWith(2);
        expect(isPageRendered).toHaveBeenCalledWith(3);
        expect(invalidatePages).toHaveBeenCalledWith([
            2,
            3,
        ]);
        expect(hideManagedAnnotationEditors).toHaveBeenCalledWith(2);
    });
});
