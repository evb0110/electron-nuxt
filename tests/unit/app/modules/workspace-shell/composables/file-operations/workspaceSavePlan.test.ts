import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    createWorkspaceSavePlan,
    type IWorkspaceSaveDirtyState,
    type TWorkspaceSaveRequest,
} from '@app/modules/workspace-shell/composables/file-operations/workspaceSavePlan';
import {requireDocumentRevisionToken} from '@contracts';

const CLEAN_DIRTY_STATE: IWorkspaceSaveDirtyState = {
    annotationChanges: false,
    annotationDirty: false,
    bookmarks: false,
    livePdfJsAnnotations: false,
    pageLabels: false,
    pendingDeletes: false,
    preservedAnnotationSource: false,
    savedPdfjsAnnotationBaseline: false,
    shapes: false,
};

function dirtyState(
    overrides: Partial<IWorkspaceSaveDirtyState> = {},
): IWorkspaceSaveDirtyState {
    return {
        ...CLEAN_DIRTY_STATE,
        ...overrides,
    };
}

function buildPlan(options: {
    request?: TWorkspaceSaveRequest;
    dirtyState?: IWorkspaceSaveDirtyState;
    hasManagedShapes?: boolean;
    canPersistNativeWorkingCopy?: boolean;
    canPersistNativeMutations?: boolean;
} = {}) {
    return createWorkspaceSavePlan({
        request: options.request ?? {kind: 'save'},
        target: {
            expectedOriginalPath: '/tmp/source.pdf',
            expectedWorkingPath: '/tmp/work.pdf',
            expectedRevisionToken: requireDocumentRevisionToken('rev-1'),
        },
        baseline: {
            annotations: 'annotations-1',
            pageLabels: 'labels-1',
            bookmarks: 'bookmarks-1',
        },
        dirtyState: options.dirtyState ?? CLEAN_DIRTY_STATE,
        hasManagedShapes: options.hasManagedShapes ?? false,
        canPersistNativeWorkingCopy: options.canPersistNativeWorkingCopy ?? false,
        canPersistNativeMutations: options.canPersistNativeMutations ?? false,
    });
}

describe('workspaceSavePlan', () => {
    it('represents clean Save and Save As as working-copy sourced serialized plans', () => {
        const save = buildPlan();
        const saveAs = buildPlan({request: {
            kind: 'save-as',
            optimizeLossless: true,
        }});

        expect(save).toMatchObject({
            kind: 'serialized',
            destination: 'original',
            body: {
                source: 'working-copy',
                requiresLargeFileGuard: false,
            },
        });
        expect(saveAs).toMatchObject({
            kind: 'serialized',
            destination: 'save-as',
            body: {source: 'working-copy'},
        });
        expect(saveAs.target).toEqual({
            expectedOriginalPath: '/tmp/source.pdf',
            expectedWorkingPath: '/tmp/work.pdf',
            expectedRevisionToken: requireDocumentRevisionToken('rev-1'),
        });
    });

    it.each([
        [
            {kind: 'repair'} as const,
            'repair',
        ],
        [
            {kind: 'optimize'} as const,
            'optimize',
        ],
    ])('plans clean %s through native working-copy persistence', (request, operation) => {
        expect(buildPlan({
            request,
            canPersistNativeWorkingCopy: true,
        })).toMatchObject({
            kind: 'native-working-copy',
            operation,
        });
    });

    it('plans dirty repair and optimize requests as serialized rewrites', () => {
        const plan = buildPlan({
            request: {kind: 'repair'},
            dirtyState: dirtyState({annotationDirty: true}),
            canPersistNativeWorkingCopy: true,
        });

        expect(plan).toMatchObject({
            kind: 'serialized',
            destination: 'original',
            body: {
                source: 'live-pdfjs',
                forceRewrite: true,
                requiresLargeFileGuard: true,
            },
        });
    });

    it('plans eligible dirty Save through native mutations with an explicit serialized fallback', () => {
        const plan = buildPlan({
            dirtyState: dirtyState({annotationChanges: true}),
            canPersistNativeMutations: true,
        });

        expect(plan).toMatchObject({
            kind: 'native-mutation',
            serializedFallback: {
                source: 'live-pdfjs',
                preserveLoadedSource: true,
                requiresLargeFileGuard: true,
            },
        });
    });

    it('keeps dirty Save As and native-disabled Save on the serialized route', () => {
        expect(buildPlan({
            request: {
                kind: 'save-as',
                optimizeLossless: false,
            },
            dirtyState: dirtyState({annotationChanges: true}),
            canPersistNativeMutations: true,
        }).kind).toBe('serialized');
        expect(buildPlan({dirtyState: dirtyState({annotationChanges: true})}).kind).toBe('serialized');
    });

    it('requires serialized materialization when managed shapes need the live source', () => {
        const plan = buildPlan({
            dirtyState: dirtyState({preservedAnnotationSource: true}),
            hasManagedShapes: true,
            canPersistNativeMutations: true,
        });

        expect(plan).toMatchObject({
            kind: 'serialized',
            body: {
                source: 'live-pdfjs',
                includeManagedShapes: true,
                preserveLoadedSource: true,
            },
        });
    });

    it('keeps saved PDF.js baseline changes out of native mutation persistence', () => {
        const plan = buildPlan({
            dirtyState: dirtyState({savedPdfjsAnnotationBaseline: true}),
            canPersistNativeMutations: true,
        });

        expect(plan).toMatchObject({
            kind: 'serialized',
            body: {
                source: 'live-pdfjs',
                preserveLoadedSource: false,
            },
        });
    });

    it('uses the optimization variant only for optimize-copy requests', () => {
        expect(buildPlan({request: {
            kind: 'optimize-copy',
            options: {preset: 'lossless'},
            requestId: 'optimize-1',
        }})).toMatchObject({
            kind: 'optimization',
            request: {
                kind: 'optimize-copy',
                requestId: 'optimize-1',
            },
        });
    });
});
