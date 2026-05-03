import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
    describe,
    expect,
    it,
} from 'vitest';

describe('pdfjs-overrides.css', () => {
    const css = readFileSync(
        resolve(process.cwd(), 'app/assets/css/pdfjs-overrides.css'),
        'utf-8',
    );

    it('targets PDF.js draw-layer highlight SVG roots during selection-markup authoring', () => {
        expect(css).toContain('.pdfViewer.is-selection-markup-tool .highlight:is(.canvasWrapper svg)');
        expect(css).toContain('.pdfViewer.is-selection-markup-tool .highlightOutline:is(.canvasWrapper svg)');
        expect(css).not.toContain('.pdfViewer .canvasWrapper svg .highlight,');
        expect(css).not.toContain('.pdfViewer .canvasWrapper svg .highlightOutline,');
    });

    it('uses app selection-markup mode rather than transient PDF.js highlightEditing mode for hit testing', () => {
        expect(css).toContain('.pdfViewer.is-selection-markup-tool .annotationEditorLayer .highlightEditor .internal');
        expect(css).not.toContain('.annotationEditorLayer.highlightEditing .highlightEditor .internal');
    });

    it('uses a composite overlay for text highlights before blending with the page', () => {
        expect(css).toContain('.pdfViewer .pdf-highlight-composite-overlay');
        expect(css).toContain('.highlight.pdf-highlight-composite-source:is(.canvasWrapper svg):not(.free)');
        expect(css).toContain('mix-blend-mode: darken !important;');
    });
});
