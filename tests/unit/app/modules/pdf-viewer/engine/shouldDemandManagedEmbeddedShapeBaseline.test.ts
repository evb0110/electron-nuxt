import {
    describe,
    expect,
    it,
} from 'vitest';
import type { TAnnotationTool } from '@app/types/annotations';
import { shouldDemandManagedEmbeddedShapeBaseline } from '@app/modules/pdf-viewer/engine/pdf-embedded-shape-import-policy/shouldDemandManagedEmbeddedShapeBaseline';

describe('shouldDemandManagedEmbeddedShapeBaseline', () => {
    it.each<TAnnotationTool>([
        'select',
        'rectangle',
        'circle',
        'line',
        'arrow',
        'draw',
    ])('loads the managed shape model for %s interaction', (tool) => {
        expect(shouldDemandManagedEmbeddedShapeBaseline(tool)).toBe(true);
    });

    it.each<TAnnotationTool>([
        'none',
        'highlight',
        'underline',
        'strikethrough',
        'squiggly',
        'text',
        'stamp',
    ])('does not load the shape model for unrelated %s interaction', (tool) => {
        expect(shouldDemandManagedEmbeddedShapeBaseline(tool)).toBe(false);
    });
});
