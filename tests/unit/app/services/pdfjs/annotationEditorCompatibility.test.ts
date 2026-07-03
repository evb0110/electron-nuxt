// @vitest-environment happy-dom

import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    createPdfAnnotationEditorCompatibilityAdapter,
    getPdfAnnotationEditorCompatibilityProbeFailures,
} from '@app/services/pdfjs/annotationEditorCompatibility';

class MockAnnotationEditorLayer {
    public div: HTMLElement | null = null;
    public didDisable = false;
    public didDestroy = false;

    disable() {
        if (!this.div) {
            throw new Error('missing div');
        }
        this.didDisable = true;
    }

    destroy() {
        if (!this.div) {
            throw new Error('missing div');
        }
        this.div = null;
        this.didDestroy = true;
    }
}

class MockAnnotationEditorUIManager {
    public layer: unknown = null;

    get currentLayer() {
        return this.layer;
    }
}

function createRuntime(overrides: Record<string, unknown> = {}) {
    return {
        version: '5.7.284',
        AnnotationEditorLayer: MockAnnotationEditorLayer,
        AnnotationEditorUIManager: MockAnnotationEditorUIManager,
        ...overrides,
    };
}

describe('annotation editor compatibility adapter', () => {
    it('detects the supported pdf.js annotation editor shape', () => {
        expect(getPdfAnnotationEditorCompatibilityProbeFailures(createRuntime())).toEqual([]);
    });

    it('wraps layer disable with a fallback div when pdf.js nulled the original layer div', () => {
        const adapter = createPdfAnnotationEditorCompatibilityAdapter({
            failInDev: true,
            runtime: createRuntime(),
        });
        const layer = adapter.wrapEditorLayer(new MockAnnotationEditorLayer());

        expect(() => layer.disable()).not.toThrow();
        expect(layer.didDisable).toBe(true);
        expect(layer.div).toBeInstanceOf(HTMLDivElement);
    });

    it('wraps layer destroy with a fallback div and leaves a div available after destroy', () => {
        const adapter = createPdfAnnotationEditorCompatibilityAdapter({
            failInDev: true,
            runtime: createRuntime(),
        });
        const layer = adapter.wrapEditorLayer(new MockAnnotationEditorLayer());

        expect(() => layer.destroy()).not.toThrow();
        expect(layer.didDestroy).toBe(true);
        expect(layer.div).toBeInstanceOf(HTMLDivElement);
    });

    it('wraps currentLayer with the fallback only when the getter exists', () => {
        const adapter = createPdfAnnotationEditorCompatibilityAdapter({
            failInDev: true,
            runtime: createRuntime(),
        });
        const uiManager = adapter.wrapUiManager(new MockAnnotationEditorUIManager());

        expect(uiManager.currentLayer).toMatchObject({
            pageIndex: -1,
            div: expect.any(HTMLDivElement),
        });
    });

    it('fails loudly in dev when required pdf.js internals are absent', () => {
        expect(() => createPdfAnnotationEditorCompatibilityAdapter({
            failInDev: true,
            runtime: createRuntime({AnnotationEditorLayer: class BrokenLayer {
                public readonly broken = true;
            }}),
        })).toThrow(/AnnotationEditorLayer\.disable is missing/u);
    });

    it('logs once in production and marks the adapter unsupported', () => {
        const warn = vi.fn();
        const first = createPdfAnnotationEditorCompatibilityAdapter({
            failInDev: false,
            logger: {
                warn,
                debug: vi.fn(),
            },
            runtime: createRuntime({AnnotationEditorUIManager: class BrokenUiManager {
                public readonly broken = true;
            }}),
        });
        createPdfAnnotationEditorCompatibilityAdapter({
            failInDev: false,
            logger: {
                warn,
                debug: vi.fn(),
            },
            runtime: createRuntime({AnnotationEditorUIManager: class BrokenUiManager {
                public readonly broken = true;
            }}),
        });

        expect(first.report.severity).toBe('unsupported');
        expect(warn).toHaveBeenCalledTimes(1);
    });
});
