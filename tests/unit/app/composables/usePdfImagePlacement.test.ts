import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    effectScope,
    ref,
} from 'vue';
import {
    getInitialImagePlacementRect,
    usePdfImagePlacement,
} from '@app/composables/pdf/usePdfImagePlacement';

function toElement<T extends object>(value: T) {
    return value as HTMLElement;
}

describe('usePdfImagePlacement', () => {
    const createObjectURL = vi.fn(() => 'blob:preview');
    const revokeObjectURL = vi.fn();

    beforeEach(() => {
        vi.clearAllMocks();
        vi.stubGlobal('URL', {
            createObjectURL,
            revokeObjectURL,
        });
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    function createViewerContainer() {
        const canvas = {
            width: 1200,
            height: 1600,
        } as HTMLCanvasElement;
        const pageContainer = toElement({
            getBoundingClientRect: () => ({
                x: 0,
                y: 0,
                left: 0,
                top: 0,
                right: 600,
                bottom: 800,
                width: 600,
                height: 800,
                toJSON: () => ({}),
            }),
            clientWidth: 600,
            clientHeight: 800,
            querySelector: vi.fn((selector: string) =>
                selector === '.page_canvas canvas' ? canvas : null),
        });

        return toElement({ querySelector: vi.fn((selector: string) =>
            selector === '.page_container[data-page="1"]' ? pageContainer : null) });
    }

    it('clamps the initial placement rect to page bounds', () => {
        expect(getInitialImagePlacementRect({
            pageNumber: 2,
            pageX: 0,
            pageY: 1,
            pageWidthPx: 600,
            pageHeightPx: 800,
        }, {
            width: 0.4,
            height: 0.3,
        })).toEqual({
            pageNumber: 2,
            x: 0,
            y: 0.7,
            width: 0.4,
            height: 0.3,
        });
    });

    it('returns false and leaves no draft when image decoding fails', async () => {
        vi.stubGlobal('createImageBitmap', vi.fn(async () => {
            throw new Error('decode failed');
        }));

        const viewerContainer = ref<HTMLElement | null>(createViewerContainer());
        const finalized = vi.fn();
        const scope = effectScope();
        const imagePlacement = scope.run(() => usePdfImagePlacement({
            viewerContainer,
            currentPage: ref(1),
            numPages: ref(4),
            effectiveScale: ref(2),
            emitFinalize: finalized,
        }));

        if (!imagePlacement) {
            throw new Error('Failed to create image placement composable');
        }

        try {
            const didStart = await imagePlacement.startImagePlacement(
                new File([new Uint8Array([
                    1,
                    2,
                    3,
                ])], 'broken.png', { type: 'image/png' }),
            );

            expect(didStart).toBe(false);
            expect(imagePlacement.pendingImagePlacement.value).toBeNull();
            expect(finalized).not.toHaveBeenCalled();
        } finally {
            scope.stop();
        }
    });

    it('finalizes with target pixel dimensions derived from the rendered page size', async () => {
        vi.stubGlobal('createImageBitmap', vi.fn(async () => ({
            width: 400,
            height: 200,
            close: vi.fn(),
        })));

        const viewerContainer = ref<HTMLElement | null>(createViewerContainer());
        const finalized = vi.fn();
        const scope = effectScope();
        const imagePlacement = scope.run(() => usePdfImagePlacement({
            viewerContainer,
            currentPage: ref(1),
            numPages: ref(4),
            effectiveScale: ref(2),
            emitFinalize: finalized,
        }));

        if (!imagePlacement) {
            throw new Error('Failed to create image placement composable');
        }

        try {
            await imagePlacement.startImagePlacement(
                new File([new Uint8Array([
                    1,
                    2,
                    3,
                ])], 'image.png', { type: 'image/png' }),
            );
            imagePlacement.updatePendingImagePlacementRect({
                x: 0.1,
                y: 0.2,
                width: 0.25,
                height: 0.5,
                rotationDegrees: 90,
            });

            imagePlacement.requestPendingImagePlacementFinalize();

            expect(finalized).toHaveBeenCalledOnce();
            expect(finalized).toHaveBeenCalledWith(expect.objectContaining({
                pageNumber: 1,
                x: 0.1,
                y: 0.2,
                width: 0.25,
                height: 0.5,
                rotationDegrees: 90,
                fileName: 'image.png',
                mimeType: 'image/png',
                targetPixelWidth: 150,
                targetPixelHeight: 400,
            }));
        } finally {
            scope.stop();
        }
    });

    it('upsizes tiny finalized placements before serialization', async () => {
        vi.stubGlobal('createImageBitmap', vi.fn(async () => ({
            width: 400,
            height: 400,
            close: vi.fn(),
        })));

        const viewerContainer = ref<HTMLElement | null>(createViewerContainer());
        const finalized = vi.fn();
        const scope = effectScope();
        const imagePlacement = scope.run(() => usePdfImagePlacement({
            viewerContainer,
            currentPage: ref(1),
            numPages: ref(4),
            effectiveScale: ref(2),
            emitFinalize: finalized,
        }));

        if (!imagePlacement) {
            throw new Error('Failed to create image placement composable');
        }

        try {
            await imagePlacement.startImagePlacement(
                new File([new Uint8Array([
                    1,
                    2,
                    3,
                ])], 'tiny.png', { type: 'image/png' }),
            );
            imagePlacement.updatePendingImagePlacementRect({
                x: 0.15,
                y: 0.2,
                width: 0.01,
                height: 0.01,
                rotationDegrees: 0,
            });

            imagePlacement.requestPendingImagePlacementFinalize();

            expect(finalized).toHaveBeenCalledOnce();
            expect(finalized).toHaveBeenCalledWith(expect.objectContaining({
                fileName: 'tiny.png',
                targetPixelWidth: 48,
                targetPixelHeight: 64,
            }));
        } finally {
            scope.stop();
        }
    });

    it('revokes the preview URL when the draft is cleared', async () => {
        vi.stubGlobal('createImageBitmap', vi.fn(async () => ({
            width: 400,
            height: 200,
            close: vi.fn(),
        })));

        const viewerContainer = ref<HTMLElement | null>(createViewerContainer());
        const scope = effectScope();
        const imagePlacement = scope.run(() => usePdfImagePlacement({
            viewerContainer,
            currentPage: ref(1),
            numPages: ref(4),
            effectiveScale: ref(2),
            emitFinalize: vi.fn(),
        }));

        if (!imagePlacement) {
            throw new Error('Failed to create image placement composable');
        }

        try {
            await imagePlacement.startImagePlacement(
                new File([new Uint8Array([
                    1,
                    2,
                    3,
                ])], 'image.png', { type: 'image/png' }),
            );

            imagePlacement.clearPendingImagePlacement();

            expect(revokeObjectURL).toHaveBeenCalledWith('blob:preview');
            expect(imagePlacement.pendingImagePlacement.value).toBeNull();
        } finally {
            scope.stop();
        }
    });
});
