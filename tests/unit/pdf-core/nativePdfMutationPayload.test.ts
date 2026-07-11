import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    PDF_NATIVE_MUTATION_LIMITS,
    normalizePdfNativeMutationSet,
    normalizePdfNativeNoteChanges,
    normalizePdfNativeNoteTextUpdates,
    normalizePdfNativeWorkingCopyExpectation,
} from '@contracts/nativePdfMutations';

const validNoteTextUpdate = {
    objectNumber: 42,
    generationNumber: 0,
    text: 'Updated note',
};

const validFreeTextNote = {
    pageIndex: 0,
    stableKey: 'uid:0:pdfjs_internal_editor_0',
    text: 'Editor note',
    markerRect: {
        left: 0.1,
        top: 0.2,
        width: 0.0016,
        height: 0.0016,
    },
};

const validPageLabelRange = {
    startPage: 1,
    style: 'D',
    prefix: '',
    startNumber: 1,
};

const validShape = {
    type: 'rectangle',
    pageIndex: 0,
    x: 0.1,
    y: 0.2,
    width: 0.3,
    height: 0.2,
    color: '#336699',
    opacity: 0.5,
    strokeWidth: 3,
};

const validImage = {
    pageIndex: 0,
    x: 0.1,
    y: 0.2,
    width: 0.3,
    height: 0.2,
    rotationDegrees: 0,
    mimeType: 'image/jpeg',
    source: {
        path: '/tmp/image.jpg',
        size: 3,
        sha256: 'a'.repeat(64),
        leaseId: 'image-lease',
        revision: null,
    },
};

interface INativeBookmarkTestItem {
    title: string;
    pageIndex: number | null;
    namedDest: string | null;
    bold: boolean;
    italic: boolean;
    color: string | null;
    items: INativeBookmarkTestItem[];
}

function createBookmark(title = 'Chapter'): INativeBookmarkTestItem {
    return {
        title,
        pageIndex: 0,
        namedDest: null,
        bold: false,
        italic: false,
        color: null,
        items: [],
    };
}

function createDeepBookmarkItems(depth: number) {
    const root = createBookmark('Root');
    let current = root;
    for (let index = 0; index < depth; index += 1) {
        const child = createBookmark(`Child ${index}`);
        current.items = [child];
        current = child;
    }
    return [root];
}

describe('native PDF mutation payload policy', () => {
    it('normalizes every native mutation family for preload and native-tool payloads', () => {
        const rawMutations = {
            updates: [validNoteTextUpdate],
            freeTextNotes: [validFreeTextNote],
            pageLabels: {
                totalPages: 3,
                ranges: [validPageLabelRange],
            },
            bookmarks: {
                totalPages: 3,
                untitledLabel: 'Untitled',
                items: [createBookmark()],
            },
            shapes: {
                totalPages: 3,
                rewriteShapeState: true,
                shapes: [validShape],
                deletedAnnotationIds: ['44R'],
                deletedStableKeys: ['evb-shape:deleted'],
            },
            markup: {
                overrides: [[
                    '44R',
                    'Squiggly',
                ]],
                hints: [{
                    subtype: 'Squiggly',
                    pageIndex: 0,
                    markerRect: {
                        left: 0.1,
                        top: 0.2,
                        width: 0.3,
                        height: 0.2,
                    },
                    annotationId: '44R',
                }],
            },
            placedImages: [validImage],
        };

        const preloadPayload = normalizePdfNativeMutationSet(rawMutations, 'mutations');
        expect(preloadPayload.placedImages?.[0]?.source).toEqual(validImage.source);
    });

    it('enforces shared native mutation limits from the pdf-core policy owner', () => {
        expect(() => normalizePdfNativeNoteTextUpdates(
            Array.from({length: PDF_NATIVE_MUTATION_LIMITS.noteTextUpdates + 1}, () => validNoteTextUpdate),
            'updates',
        )).toThrow(`at most ${PDF_NATIVE_MUTATION_LIMITS.noteTextUpdates} updates`);

        expect(() => normalizePdfNativeNoteChanges({freeTextNotes: Array.from({length: PDF_NATIVE_MUTATION_LIMITS.noteChanges + 1}, () => validFreeTextNote)}, 'changes')).toThrow(`at most ${PDF_NATIVE_MUTATION_LIMITS.noteChanges} notes`);

        expect(() => normalizePdfNativeMutationSet({pageLabels: {
            totalPages: 3,
            ranges: Array.from({length: PDF_NATIVE_MUTATION_LIMITS.pageLabelRanges + 1}, () => validPageLabelRange),
        }}, 'mutations')).toThrow(`at most ${PDF_NATIVE_MUTATION_LIMITS.pageLabelRanges} ranges`);

        expect(() => normalizePdfNativeMutationSet({bookmarks: {
            totalPages: 3,
            untitledLabel: 'Untitled',
            items: Array.from({length: PDF_NATIVE_MUTATION_LIMITS.bookmarkItems + 1}, (_, index) =>
                createBookmark(`Chapter ${index}`)),
        }}, 'mutations')).toThrow(`at most ${PDF_NATIVE_MUTATION_LIMITS.bookmarkItems} items`);

        expect(() => normalizePdfNativeMutationSet({bookmarks: {
            totalPages: 3,
            untitledLabel: 'Untitled',
            items: createDeepBookmarkItems(PDF_NATIVE_MUTATION_LIMITS.bookmarkDepth + 1),
        }}, 'mutations')).toThrow('maximum bookmark depth');

        expect(() => normalizePdfNativeMutationSet({shapes: {
            totalPages: 3,
            rewriteShapeState: true,
            shapes: [validShape],
            deletedAnnotationIds: Array.from(
                {length: PDF_NATIVE_MUTATION_LIMITS.shapeDeletedItems + 1},
                (_, index) => `${index}R`,
            ),
            deletedStableKeys: [],
        }}, 'mutations')).toThrow(`at most ${PDF_NATIVE_MUTATION_LIMITS.shapeDeletedItems} items`);

        expect(() => normalizePdfNativeMutationSet({shapes: {
            totalPages: 3,
            rewriteShapeState: true,
            shapes: [{
                ...validShape,
                points: Array.from({length: PDF_NATIVE_MUTATION_LIMITS.shapePoints + 1}, () => ({
                    x: 0.1,
                    y: 0.2,
                })),
            }],
            deletedAnnotationIds: [],
            deletedStableKeys: [],
        }}, 'mutations')).toThrow(`at most ${PDF_NATIVE_MUTATION_LIMITS.shapePoints} points`);

        expect(() => normalizePdfNativeMutationSet({markup: {
            overrides: Array.from({length: PDF_NATIVE_MUTATION_LIMITS.markupItems + 1}, (_, index) => [
                `${index}R`,
                'Highlight',
            ]),
            hints: [],
        }}, 'mutations')).toThrow(`at most ${PDF_NATIVE_MUTATION_LIMITS.markupItems} items`);

        expect(() => normalizePdfNativeMutationSet({markup: {
            overrides: [[
                'x'.repeat(PDF_NATIVE_MUTATION_LIMITS.markupTextLength + 1),
                'Highlight',
            ]],
            hints: [],
        }}, 'mutations')).toThrow('bounded annotation id');

        expect(() => normalizePdfNativeMutationSet({placedImages: Array.from({length: PDF_NATIVE_MUTATION_LIMITS.placedImages + 1}, () => validImage)}, 'mutations')).toThrow(`at most ${PDF_NATIVE_MUTATION_LIMITS.placedImages} images`);

        expect(() => normalizePdfNativeMutationSet({placedImages: [{
            ...validImage,
            source: null,
        }]}, 'mutations')).toThrow('valid managed binary handle');
    });

    it('normalizes working-copy expectations with the shared SHA-256 guard', () => {
        expect(normalizePdfNativeWorkingCopyExpectation({
            byteLength: 3,
            sha256: 'A'.repeat(64),
        }, 'expectedBase')).toEqual({
            byteLength: 3,
            sha256: 'a'.repeat(64),
        });

        expect(() => normalizePdfNativeWorkingCopyExpectation({
            byteLength: 3,
            sha256: 'not-a-digest',
        }, 'expectedBase')).toThrow('SHA-256 hex digest');
    });

    it('accepts native mutation bounds that exactly touch normalized page edges', () => {
        const normalized = normalizePdfNativeMutationSet({
            freeTextNotes: [{
                ...validFreeTextNote,
                markerRect: {
                    left: 0.5,
                    top: 0.25,
                    width: 0.5,
                    height: 0.75,
                },
            }],
            placedImages: [{
                ...validImage,
                x: 0.75,
                y: 0.5,
                width: 0.25,
                height: 0.5,
            }],
        }, 'mutations');

        expect(normalized.freeTextNotes?.[0]?.markerRect).toEqual({
            left: 0.5,
            top: 0.25,
            width: 0.5,
            height: 0.75,
        });
        expect(normalized.placedImages?.[0]).toMatchObject({
            x: 0.75,
            y: 0.5,
            width: 0.25,
            height: 0.5,
        });
    });

    it('rejects zero-sized and overflowing normalized page bounds', () => {
        expect(() => normalizePdfNativeMutationSet({freeTextNotes: [{
            ...validFreeTextNote,
            markerRect: {
                ...validFreeTextNote.markerRect,
                width: 0,
            },
        }]}, 'mutations')).toThrow('must fit inside the normalized page bounds');

        expect(() => normalizePdfNativeMutationSet({placedImages: [{
            ...validImage,
            x: 0.75,
            width: 0.26,
        }]}, 'mutations')).toThrow('must fit inside the normalized page bounds');
    });
});
