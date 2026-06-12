import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    computeShouldSerializeFlag,
    shouldPreserveLiveAnnotationSession,
    type IDocumentDirtyState,
    type TDocumentDirtySource,
} from '@app/modules/workspace-shell/composables/file-operations/saveDirtyState';

const CLEAN_DIRTY_STATE: IDocumentDirtyState = {
    annotationChanges: false,
    annotationDirty: false,
    bookmarks: false,
    livePdfJsAnnotations: false,
    pageLabels: false,
    pendingDeletes: false,
    pendingTexts: false,
    preservedAnnotationSource: false,
    savedPdfjsAnnotationBaseline: false,
    shapes: false,
};

function dirtyState(overrides: Partial<IDocumentDirtyState> = {}): IDocumentDirtyState {
    return {
        ...CLEAN_DIRTY_STATE,
        ...overrides,
    };
}

type TPreserveLiveSessionCase = [
    string,
    {
        dirtyState?: IDocumentDirtyState;
        mode?: 'save' | 'save_as';
        shouldSerialize?: boolean;
    },
];

const DOES_NOT_PRESERVE_LIVE_SESSION_CASES: TPreserveLiveSessionCase[] = [
    [
        'Save As mode',
        {mode: 'save_as'},
    ],
    [
        'non-serialized save',
        {shouldSerialize: false},
    ],
    [
        'pending deletes',
        {dirtyState: dirtyState({
            pendingDeletes: true,
            pendingTexts: true,
        })},
    ],
    [
        'page labels',
        {dirtyState: dirtyState({
            pageLabels: true,
            pendingTexts: true,
        })},
    ],
    [
        'bookmarks',
        {dirtyState: dirtyState({
            bookmarks: true,
            pendingTexts: true,
        })},
    ],
    [
        'annotation dirty only',
        {dirtyState: dirtyState({annotationDirty: true})},
    ],
    [
        'saved PDF.js baseline only',
        {dirtyState: dirtyState({savedPdfjsAnnotationBaseline: true})},
    ],
];

describe('saveDirtyState', () => {
    it('serializes when any tracked dirty source is present', () => {
        expect(computeShouldSerializeFlag(dirtyState())).toBe(false);

        for (const source of Object.keys(CLEAN_DIRTY_STATE) as TDocumentDirtySource[]) {
            expect(computeShouldSerializeFlag(dirtyState({[source]: true}))).toBe(true);
        }
    });

    it.each([
        [
            'shapes',
            {shapes: true},
        ],
        [
            'pending text updates',
            {pendingTexts: true},
        ],
        [
            'live PDF.js annotations',
            {livePdfJsAnnotations: true},
        ],
        [
            'preserved annotation source',
            {preservedAnnotationSource: true},
        ],
        [
            'annotation changes',
            {annotationChanges: true},
        ],
    ] as const)('preserves the live annotation session for save serialization with %s', (_label, overrides) => {
        expect(shouldPreserveLiveAnnotationSession({
            dirtyState: dirtyState(overrides),
            mode: 'save',
            shouldSerialize: true,
        })).toBe(true);
    });

    it.each(DOES_NOT_PRESERVE_LIVE_SESSION_CASES)('does not preserve the live annotation session for %s', (_label, overrides) => {
        expect(shouldPreserveLiveAnnotationSession({
            dirtyState: overrides.dirtyState ?? dirtyState({pendingTexts: true}),
            mode: overrides.mode ?? 'save',
            shouldSerialize: overrides.shouldSerialize ?? true,
        })).toBe(false);
    });
});
