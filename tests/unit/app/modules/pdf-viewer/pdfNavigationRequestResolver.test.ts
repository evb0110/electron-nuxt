import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { cast } from '@tests/helpers/cast';
import type { PDFDocumentProxy } from '@app/types/pdfContracts';
import {
    isPdfNavigationReady,
    resolvePdfNavigationAnchor,
    resolvePdfNavigationTarget,
    resolveTextAnchorRect,
} from '@app/modules/pdf-viewer/runtime/viewport/pdfNavigationRequestResolver';
import type { IPdfNavigationRequest } from '@app/modules/pdf-viewer/engine/viewport/createPageNavigationRequest';

function request(overrides: Partial<IPdfNavigationRequest> = {}): IPdfNavigationRequest {
    return {
        target: {
            kind: 'page',
            page: 2,
        },
        alignment: 'page-top',
        readiness: 'page-canvas',
        source: 'toolbar',
        supersession: 'latest-wins',
        ...overrides,
    };
}

describe('PDF navigation request resolver', () => {
    it.each([
        [
            'toolbar',
            'page',
        ],
        [
            'wheel',
            'page',
        ],
        [
            'search',
            'text-anchor',
        ],
        [
            'bookmark',
            'named-dest',
        ],
        [
            'annotation',
            'rect',
        ],
        [
            'thumbnail',
            'page',
        ],
        [
            'activation',
            'page',
        ],
        [
            'restore',
            'page',
        ],
    ] as const)('preserves the %s source while resolving a %s target', async (source, kind) => {
        const targets = {
            page: {
                kind: 'page',
                page: 2,
            },
            rect: {
                kind: 'rect',
                page: 2,
                rect: {
                    left: 0.1,
                    top: 0.2,
                    width: 0.3,
                    height: 0.4,
                },
            },
            'text-anchor': {
                kind: 'text-anchor',
                page: 2,
                text: 'needle',
            },
            'named-dest': {
                kind: 'named-dest',
                destination: [1] as unknown[],
            },
        } as const;
        const pdfDocument = cast<PDFDocumentProxy>({
            numPages: 3,
            getDestination: vi.fn(async () => null),
            getPageIndex: vi.fn(async () => 1),
            getPage: vi.fn(),
        });
        const navigation = request({
            source,
            target: targets[kind],
        });
        const resolved = await resolvePdfNavigationTarget(navigation.target, pdfDocument);
        expect(navigation.source).toBe(source);
        expect(resolved.page).toBe(2);
    });

    it('resolves page-top and rect-center alignments deterministically', () => {
        const target = {
            page: 4,
            rect: {
                left: 0.2,
                top: 0.3,
                width: 0.4,
                height: 0.2,
            },
        };
        expect(resolvePdfNavigationAnchor(request({alignment: 'page-top'}), target)).toMatchObject({
            page: 4,
            pageYFraction: 0.3,
            viewportYFraction: 0,
            affinity: 'start',
        });
        expect(resolvePdfNavigationAnchor(request({alignment: 'rect-center'}), target)).toMatchObject({
            page: 4,
            pageXFraction: 0.4,
            pageYFraction: 0.4,
            viewportXFraction: 0.5,
            viewportYFraction: 0.5,
            affinity: 'center',
        });
    });

    it('resolves a text anchor to normalized page geometry', () => {
        const span = cast<HTMLElement>({
            textContent: 'prefix needle suffix',
            getBoundingClientRect: () => cast<DOMRect>({
                left: 30,
                top: 50,
                width: 20,
                height: 10,
            }),
        });
        const textLayer = cast<HTMLElement>({querySelectorAll: () => [span]});
        const page = cast<HTMLElement>({
            getBoundingClientRect: () => cast<DOMRect>({
                left: 10,
                top: 10,
                width: 100,
                height: 200,
            }),
            querySelector: () => textLayer,
        });
        const container = cast<HTMLElement>({querySelector: () => page});
        expect(resolveTextAnchorRect(container, {
            kind: 'text-anchor',
            page: 2,
            text: 'needle',
            prefix: 'prefix ',
            suffix: ' suffix',
        })).toEqual({
            left: 0.2,
            top: 0.2,
            width: 0.2,
            height: 0.05,
        });
    });

    it.each([
        [
            'metrics',
            true,
        ],
        [
            'page-canvas',
            true,
        ],
        [
            'text-layer',
            true,
        ],
        [
            'annotation-editor',
            true,
        ],
    ] as const)('honors %s readiness', (readiness, expected) => {
        const page = cast<HTMLElement>({querySelector: (selector: string) => selector.includes('text') || selector.includes('annotation') ? {} : null});
        const container = cast<HTMLElement>({querySelector: () => page});
        expect(isPdfNavigationReady(container, 2, readiness, () => true)).toBe(expected);
    });
});
