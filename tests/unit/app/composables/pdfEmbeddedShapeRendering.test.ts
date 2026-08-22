// @vitest-environment happy-dom

import {
    afterEach,
    describe,
    expect,
    it,
} from 'vitest';
import {
    createApp,
    h,
} from 'vue';
import PdfShapeOverlay from '@app/modules/pdf-viewer/components/PdfShapeOverlay.vue';
import { importEmbeddedShapeAnnotations } from '@app/modules/pdf-viewer/engine/pdf-embedded-shape-annotations/importEmbeddedShapeAnnotations';
import { createEmbeddedShapeColorPdf } from '@tests/unit/app/fixtures/createEmbeddedShapeColorPdf';

const activeUnmounts = new Set<() => void>();

afterEach(() => {
    for (const unmount of [...activeUnmounts]) {
        unmount();
    }
});

describe('embedded PDF shape rendering', () => {
    it('serializes decoded Gray, CMYK, and zero-width styling into the SVG overlay', async () => {
        const shapes = await importEmbeddedShapeAnnotations(await createEmbeddedShapeColorPdf());
        const square = shapes.find(shape => shape.stableKey === 'evb-shape:gray-cmyk-square');
        expect(square).not.toBeUndefined();

        const host = document.createElement('div');
        document.body.append(host);
        const app = createApp({setup: () => () => h(PdfShapeOverlay, {
            shapes: [square!],
            drawingShape: null,
            selectedShapeId: null,
            focusedShapeId: null,
            isActive: false,
            isAnnotationToolActive: false,
            selectionEnabled: false,
            tool: null,
            pageScale: null,
        })});
        app.mount(host);
        const unmount = () => {
            app.unmount();
            host.remove();
            activeUnmounts.delete(unmount);
        };
        activeUnmounts.add(unmount);

        const renderedSquare = host.querySelector<SVGRectElement>('g[data-stable-key="evb-shape:gray-cmyk-square"] rect:not(.shape-hit-target)');
        expect(renderedSquare?.getAttribute('stroke')).toBe('#808080');
        expect(renderedSquare?.getAttribute('fill')).toBe('#ff0000');
        expect(renderedSquare?.getAttribute('stroke-width'))
            .toBe('calc(var(--total-scale-factor, 1) * 0px)');
    });
});
