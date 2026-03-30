import {
    describe,
    expect,
    it,
} from 'vitest';
import { useAnnotationShapes } from '@app/composables/pdf/useAnnotationShapes';
import type { IShapeAnnotation } from '@app/types/annotations';

function createEmbeddedShape(): IShapeAnnotation {
    return {
        id: 'embedded-shape-1',
        type: 'rectangle',
        pageIndex: 0,
        x: 0.1,
        y: 0.15,
        width: 0.2,
        height: 0.25,
        color: '#336699',
        fillColor: '#abcdef',
        opacity: 0.6,
        strokeWidth: 3,
        source: 'embedded',
        annotationId: '12R0',
        pdfSubtype: 'Square',
    };
}

describe('useAnnotationShapes', () => {
    it('does not mark imported embedded shapes as dirty until they change', () => {
        const shapes = useAnnotationShapes();
        shapes.loadShapes([createEmbeddedShape()]);

        expect(shapes.hasShapes.value).toBe(false);

        shapes.updateShape('embedded-shape-1', { color: '#ff0000' });

        expect(shapes.hasShapes.value).toBe(true);
    });

    it('tracks deleted embedded annotation ids and clears them when the same shape is restored', () => {
        const shapes = useAnnotationShapes();
        const embeddedShape = createEmbeddedShape();

        shapes.loadShapes([embeddedShape]);
        shapes.deleteShape(embeddedShape.id);

        expect(shapes.getDeletedEmbeddedAnnotationIds()).toEqual(['12R0']);
        expect(shapes.hasShapes.value).toBe(true);

        shapes.addShape({ ...embeddedShape });

        expect(shapes.getDeletedEmbeddedAnnotationIds()).toEqual([]);
        expect(shapes.hasShapes.value).toBe(false);
    });
});
