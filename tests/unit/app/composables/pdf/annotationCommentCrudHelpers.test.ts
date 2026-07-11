// @vitest-environment happy-dom

import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { findAnnotationSummaryFromPoint } from '@app/modules/pdf-viewer/engine/annotation-comment-crud-helpers/findAnnotationSummaryFromPoint';
import type { IAnnotationCommentSummary } from '@app/types/annotations';

interface IAnnotationCrudTestRect {
    height: number;
    left: number;
    top: number;
    width: number;
}

function createElement(
    className: string,
    rect: IAnnotationCrudTestRect,
) {
    const element = document.createElement('div');
    element.className = className;
    Object.defineProperty(element, 'getBoundingClientRect', {
        configurable: true,
        value: () => ({
            ...rect,
            bottom: rect.top + rect.height,
            right: rect.left + rect.width,
            x: rect.left,
            y: rect.top,
            toJSON: () => ({}),
        }),
    });
    return element;
}

function createSummary(overrides: Partial<IAnnotationCommentSummary>): IAnnotationCommentSummary {
    return {
        id: overrides.id ?? 'ann',
        stableKey: overrides.stableKey ?? `src:pdf:0:${overrides.id ?? 'ann'}`,
        sortIndex: null,
        pageIndex: overrides.pageIndex ?? 0,
        pageNumber: overrides.pageNumber ?? 1,
        text: '',
        kindLabel: null,
        subtype: overrides.subtype ?? 'Underline',
        author: null,
        modifiedAt: overrides.modifiedAt ?? null,
        color: overrides.color ?? null,
        uid: null,
        annotationId: overrides.annotationId ?? null,
        source: overrides.source ?? 'pdf',
        markerRect: overrides.markerRect ?? {
            left: 0.1,
            top: 0.1,
            width: 0.3,
            height: 0.05,
        },
    };
}

function createPage() {
    const page = createElement('page_container', {
        left: 0,
        top: 0,
        width: 1000,
        height: 1000,
    });
    page.dataset.page = '1';
    return page;
}

describe('findAnnotationSummaryFromPoint', () => {
    beforeEach(() => {
        document.body.replaceChildren();
        Object.defineProperty(document, 'elementsFromPoint', {
            configurable: true,
            value: vi.fn(() => []),
        });
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('prefers the annotation layer element under the pointer', () => {
        const page = createPage();
        const annotationLayer = createElement('annotationLayer', {
            left: 0,
            top: 0,
            width: 1000,
            height: 1000,
        });
        const older = createElement('underlineAnnotation', {
            left: 100,
            top: 100,
            width: 300,
            height: 50,
        });
        older.dataset.annotationId = 'older';
        const topmost = createElement('underlineAnnotation', {
            left: 100,
            top: 100,
            width: 300,
            height: 50,
        });
        topmost.dataset.annotationId = 'topmost';
        page.append(annotationLayer);
        annotationLayer.append(older);
        annotationLayer.append(topmost);
        document.body.append(page);
        vi.spyOn(document, 'elementsFromPoint').mockReturnValue([topmost]);

        const summary = findAnnotationSummaryFromPoint(
            page,
            150,
            120,
            1,
            [
                createSummary({
                    id: 'older',
                    stableKey: 'ann:0:older',
                    annotationId: 'older',
                }),
                createSummary({
                    id: 'topmost',
                    stableKey: 'ann:0:topmost',
                    annotationId: 'topmost',
                }),
            ],
            () => page,
        );

        expect(summary?.annotationId).toBe('topmost');
    });

    it('breaks identical marker-rect ties toward the most recently modified summary', () => {
        const page = createPage();
        document.body.append(page);

        const summary = findAnnotationSummaryFromPoint(
            page,
            150,
            120,
            1,
            [
                createSummary({
                    id: 'older',
                    stableKey: 'ann:0:older',
                    annotationId: 'older',
                    modifiedAt: 100,
                }),
                createSummary({
                    id: 'newer',
                    stableKey: 'ann:0:newer',
                    annotationId: 'newer',
                    modifiedAt: 200,
                }),
            ],
            () => page,
        );

        expect(summary?.annotationId).toBe('newer');
    });
});
