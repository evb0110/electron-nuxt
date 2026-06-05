import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { cast } from '@tests/helpers/cast';

import { toMarkerRectFromEditor } from '@app/composables/pdf/pdfAnnotationEditorUtils';
import type { IPdfjsEditor } from '@app/types/pdfjs';

vi.mock('pdfjs-dist', () => ({PDFDateString: {toDateObject: vi.fn(() => null)}}));

interface IFakeRect {
    left: number;
    top: number;
    width: number;
    height: number;
}

function toDomRect(rect: IFakeRect) {
    return {
        x: rect.left,
        y: rect.top,
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
        right: rect.left + rect.width,
        bottom: rect.top + rect.height,
        toJSON: () => ({}),
    };
}

interface IFakeDivOptions {
    boundingRect?: IFakeRect;
    pageContainer?: HTMLElement | null;
    editorLayerByClass?: Record<string, HTMLElement | null>;
}

function createDiv(options: IFakeDivOptions) {
    const closest = vi.fn((selector: string) => {
        if (selector === '.page_container') {
            return options.pageContainer ?? null;
        }
        return options.editorLayerByClass?.[selector] ?? null;
    });
    const getBoundingClientRect = vi.fn(() =>
        toDomRect(options.boundingRect ?? {
            left: 0,
            top: 0,
            width: 0,
            height: 0,
        }));
    return cast<HTMLElement>({
        closest,
        getBoundingClientRect,
    });
}

function createPageContainer(rect: IFakeRect) {
    return cast<HTMLElement>({getBoundingClientRect: vi.fn(() => toDomRect(rect))});
}

function expectMarkerRectClose(
    actual: {
        left: number;
        top: number;
        width: number;
        height: number; 
    } | null,
    expected: {
        left: number;
        top: number;
        width: number;
        height: number; 
    },
) {
    if (!actual) {
        throw new Error('expected non-null marker rect');
    }
    expect(actual.left).toBeCloseTo(expected.left, 10);
    expect(actual.top).toBeCloseTo(expected.top, 10);
    expect(actual.width).toBeCloseTo(expected.width, 10);
    expect(actual.height).toBeCloseTo(expected.height, 10);
}

describe('toMarkerRectFromEditor', () => {
    it('returns the directly normalized rect when editor has explicit coordinates and no DOM', () => {
        const editor: IPdfjsEditor = {
            x: 0.1,
            y: 0.2,
            width: 0.3,
            height: 0.4,
        };
        expect(toMarkerRectFromEditor(editor)).toEqual({
            left: 0.1,
            top: 0.2,
            width: 0.3,
            height: 0.4,
        });
    });

    it('clamps direct rect coordinates to the unit square', () => {
        const editor: IPdfjsEditor = {
            x: -0.2,
            y: -0.1,
            width: 0.5,
            height: 0.4,
        };
        expect(toMarkerRectFromEditor(editor)).toEqual({
            left: 0,
            top: 0,
            width: 0.5,
            height: 0.4,
        });
    });

    it('returns null when the editor has no coordinates and no DOM containers', () => {
        expect(toMarkerRectFromEditor({})).toBeNull();
    });

    it('returns null when editor coordinates have non-positive size and no DOM is reachable', () => {
        const editor: IPdfjsEditor = {
            x: 0.1,
            y: 0.1,
            width: 0,
            height: 0,
        };
        expect(toMarkerRectFromEditor(editor)).toBeNull();
    });

    it('uses the direct rect when the layer rect matches the page rect', () => {
        const pageRect: IFakeRect = {
            left: 100,
            top: 50,
            width: 600,
            height: 800,
        };
        const pageContainer = createPageContainer(pageRect);
        const editorLayer = createPageContainer(pageRect);
        const div = createDiv({
            pageContainer,
            editorLayerByClass: { '.annotationEditorLayer': editorLayer },
            boundingRect: {
                left: 200,
                top: 100,
                width: 60,
                height: 80,
            },
        });
        const editor: IPdfjsEditor = {
            div,
            x: 0.2,
            y: 0.25,
            width: 0.1,
            height: 0.1,
        };
        expect(toMarkerRectFromEditor(editor)).toEqual({
            left: 0.2,
            top: 0.25,
            width: 0.1,
            height: 0.1,
        });
    });

    it('converts from layer space when the editor layer is offset within the page container', () => {
        const pageRect: IFakeRect = {
            left: 0,
            top: 0,
            width: 1000,
            height: 1000,
        };
        const layerRect: IFakeRect = {
            left: 100,
            top: 200,
            width: 500,
            height: 500,
        };
        const pageContainer = createPageContainer(pageRect);
        const editorLayer = createPageContainer(layerRect);
        const div = createDiv({
            pageContainer,
            editorLayerByClass: { '.annotationEditorLayer': editorLayer },
        });
        const editor: IPdfjsEditor = {
            div,
            x: 0.4,
            y: 0.5,
            width: 0.2,
            height: 0.2,
        };
        // expected:
        // left = (100 - 0)/1000 + 0.4 * (500/1000) = 0.1 + 0.2 = 0.3
        // top  = (200 - 0)/1000 + 0.5 * (500/1000) = 0.2 + 0.25 = 0.45
        // w = 0.2 * 0.5 = 0.1, h = 0.2 * 0.5 = 0.1
        expectMarkerRectClose(toMarkerRectFromEditor(editor), {
            left: 0.3,
            top: 0.45,
            width: 0.1,
            height: 0.1,
        });
    });

    it('falls back to the kebab-case annotation-editor-layer class when the camelCase one is missing', () => {
        const pageRect: IFakeRect = {
            left: 0,
            top: 0,
            width: 800,
            height: 600,
        };
        const layerRect: IFakeRect = {
            left: 80,
            top: 60,
            width: 400,
            height: 300,
        };
        const pageContainer = createPageContainer(pageRect);
        const editorLayer = createPageContainer(layerRect);
        const div = createDiv({
            pageContainer,
            editorLayerByClass: {
                '.annotationEditorLayer': null,
                '.annotation-editor-layer': editorLayer,
            },
        });
        const editor: IPdfjsEditor = {
            div,
            x: 0.5,
            y: 0.5,
            width: 0.4,
            height: 0.4,
        };
        // left = 80/800 + 0.5 * 0.5 = 0.1 + 0.25 = 0.35
        // top = 60/600 + 0.5 * 0.5 = 0.1 + 0.25 = 0.35
        // w = 0.4 * 0.5 = 0.2, h = 0.4 * 0.5 = 0.2
        expectMarkerRectClose(toMarkerRectFromEditor(editor), {
            left: 0.35,
            top: 0.35,
            width: 0.2,
            height: 0.2,
        });
    });

    it('falls back to editor.parent.div as the editor layer when no closest layer ancestor exists', () => {
        const pageRect: IFakeRect = {
            left: 0,
            top: 0,
            width: 1000,
            height: 1000,
        };
        const layerRect: IFakeRect = {
            left: 200,
            top: 0,
            width: 500,
            height: 1000,
        };
        const parentDiv = createPageContainer(layerRect);
        const pageContainer = createPageContainer(pageRect);
        const div = createDiv({
            pageContainer,
            editorLayerByClass: {},
        });
        const editor: IPdfjsEditor = {
            div,
            parent: { div: parentDiv },
            x: 0.2,
            y: 0.1,
            width: 0.4,
            height: 0.4,
        };
        // left = 200/1000 + 0.2 * 0.5 = 0.2 + 0.1 = 0.3
        // top = 0 + 0.1 * 1 = 0.1
        // w = 0.4 * 0.5 = 0.2, h = 0.4 * 1 = 0.4
        expectMarkerRectClose(toMarkerRectFromEditor(editor), {
            left: 0.3,
            top: 0.1,
            width: 0.2,
            height: 0.4,
        });
    });

    it('falls back to direct rect when layer-space conversion produces an invalid rect (NaN width)', () => {
        const pageRect: IFakeRect = {
            left: 0,
            top: 0,
            width: 1000,
            height: 1000,
        };
        const layerRect: IFakeRect = {
            left: 100,
            top: 100,
            width: 500,
            height: 500,
        };
        const pageContainer = createPageContainer(pageRect);
        const editorLayer = createPageContainer(layerRect);
        const div = createDiv({
            pageContainer,
            editorLayerByClass: { '.annotationEditorLayer': editorLayer },
        });
        // No editor.x / y / width / height — layer-space math yields NaN, which normalizeMarkerRect rejects.
        const editor: IPdfjsEditor = { div };
        // also no fallback since editorRect width=0
        expect(toMarkerRectFromEditor(editor)).toBeNull();
    });

    it('falls back to bounding-rect-derived coordinates when no editor rect is provided', () => {
        const pageRect: IFakeRect = {
            left: 100,
            top: 100,
            width: 500,
            height: 1000,
        };
        const pageContainer = createPageContainer(pageRect);
        const div = createDiv({
            pageContainer,
            editorLayerByClass: {},
            boundingRect: {
                left: 200,
                top: 300,
                width: 50,
                height: 200,
            },
        });
        const editor: IPdfjsEditor = { div };
        // left=(200-100)/500=0.2, top=(300-100)/1000=0.2, w=50/500=0.1, h=200/1000=0.2
        expect(toMarkerRectFromEditor(editor)).toEqual({
            left: 0.2,
            top: 0.2,
            width: 0.1,
            height: 0.2,
        });
    });

    it('returns null when the page container has zero size and no other source resolves', () => {
        const pageContainer = createPageContainer({
            left: 0,
            top: 0,
            width: 0,
            height: 0,
        });
        const div = createDiv({
            pageContainer,
            editorLayerByClass: {},
            boundingRect: {
                left: 10,
                top: 10,
                width: 20,
                height: 20,
            },
        });
        const editor: IPdfjsEditor = { div };
        expect(toMarkerRectFromEditor(editor)).toBeNull();
    });

    it('returns null when there is no editorDiv and no usable direct rect', () => {
        expect(toMarkerRectFromEditor({
            x: 0,
            y: 0,
            width: Number.NaN,
            height: 0.5,
        })).toBeNull();
    });

    it('handles negative offset (layer outside the page) by clamping to the unit square', () => {
        const pageRect: IFakeRect = {
            left: 100,
            top: 100,
            width: 1000,
            height: 1000,
        };
        const layerRect: IFakeRect = {
            left: 50,
            top: 50,
            width: 500,
            height: 500,
        };
        const pageContainer = createPageContainer(pageRect);
        const editorLayer = createPageContainer(layerRect);
        const div = createDiv({
            pageContainer,
            editorLayerByClass: { '.annotationEditorLayer': editorLayer },
        });
        const editor: IPdfjsEditor = {
            div,
            x: 0.2,
            y: 0.2,
            width: 0.2,
            height: 0.2,
        };
        // left = (50-100)/1000 + 0.2 * 0.5 = -0.05 + 0.1 = 0.05
        // top = (50-100)/1000 + 0.2 * 0.5 = -0.05 + 0.1 = 0.05
        // w = 0.2 * 0.5 = 0.1, h = 0.1
        expectMarkerRectClose(toMarkerRectFromEditor(editor), {
            left: 0.05,
            top: 0.05,
            width: 0.1,
            height: 0.1,
        });
    });

    it('treats sub-pixel layer offsets (<= 0.5 px) as identical to page rect (no layer-space conversion)', () => {
        const pageRect: IFakeRect = {
            left: 100,
            top: 100,
            width: 500,
            height: 800,
        };
        const layerRect: IFakeRect = {
            left: 100.4,
            top: 100.3,
            width: 500.2,
            height: 800.1,
        };
        const pageContainer = createPageContainer(pageRect);
        const editorLayer = createPageContainer(layerRect);
        const div = createDiv({
            pageContainer,
            editorLayerByClass: { '.annotationEditorLayer': editorLayer },
        });
        const editor: IPdfjsEditor = {
            div,
            x: 0.4,
            y: 0.5,
            width: 0.1,
            height: 0.1,
        };
        // sub-pixel diff -> direct path
        expect(toMarkerRectFromEditor(editor)).toEqual({
            left: 0.4,
            top: 0.5,
            width: 0.1,
            height: 0.1,
        });
    });

    it('clamps width down so left+width does not exceed 1', () => {
        const editor: IPdfjsEditor = {
            x: 0.8,
            y: 0.7,
            width: 0.5,
            height: 0.5,
        };
        expectMarkerRectClose(toMarkerRectFromEditor(editor), {
            left: 0.8,
            top: 0.7,
            width: 0.2,
            height: 0.3,
        });
    });
});
