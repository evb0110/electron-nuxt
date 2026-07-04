import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    buildWorkspaceSavePlan,
    type IWorkspaceSavePlanConfig,
    type IWorkspaceSavePlanInput,
} from '@app/modules/workspace-shell/composables/file-operations/workspaceSavePlan';
import type { IDocumentDirtyState } from '@app/modules/workspace-shell/composables/file-operations/saveDirtyState';

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

const BASE_CONFIG: IWorkspaceSavePlanConfig = {
    mode: 'save',
    shouldPreferWorkingCopy: true,
    canPersistNativeWorkingCopy: false,
    canAttemptNativeMutationSave: false,
};

const BASE_INPUT: IWorkspaceSavePlanInput = {
    workingCopyPath: '/tmp/work.pdf',
    expectedOriginalPath: '/tmp/source.pdf',
    expectedWorkingPath: '/tmp/work.pdf',
    expectedDocumentRevisionToken: 'rev-1',
    dirtyState: CLEAN_DIRTY_STATE,
    hasManagedShapes: false,
};

function dirtyState(overrides: Partial<IDocumentDirtyState> = {}): IDocumentDirtyState {
    return {
        ...CLEAN_DIRTY_STATE,
        ...overrides,
    };
}

function buildPlan(
    config: Partial<IWorkspaceSavePlanConfig> = {},
    input: Partial<IWorkspaceSavePlanInput> = {},
) {
    return buildWorkspaceSavePlan(
        {
            ...BASE_CONFIG,
            ...config,
        },
        {
            ...BASE_INPUT,
            ...input,
        },
    );
}

describe('workspaceSavePlan', () => {
    it('plans clean Save and Save As through the existing working copy', () => {
        expect(buildPlan().persistenceRoute).toBe('working-copy');
        expect(buildPlan().serialization).toMatchObject({
            shouldSerialize: false,
            forcedByDirtyState: false,
            requestedByRepairOrOptimization: false,
        });

        const saveAsPlan = buildPlan({
            mode: 'save_as',
            shouldPreferWorkingCopy: false,
        });

        expect(saveAsPlan.flowMode).toBe('save_as');
        expect(saveAsPlan.persistenceRoute).toBe('working-copy');
        expect(saveAsPlan.staleTargetProtection).toEqual({
            expectedOriginalPath: '/tmp/source.pdf',
            expectedWorkingPath: '/tmp/work.pdf',
            expectedDocumentRevisionToken: 'rev-1',
        });
    });

    it('plans clean repair and optimize requests through native working-copy persistence when available', () => {
        const plan = buildPlan({
            forceSerialize: true,
            forceRewrite: true,
            canPersistNativeWorkingCopy: true,
        });

        expect(plan.persistenceRoute).toBe('native-working-copy');
        expect(plan.serialization).toMatchObject({
            shouldSerialize: true,
            forcedByDirtyState: false,
            requestedByRepairOrOptimization: true,
            forceRewrite: true,
        });
        expect(plan.rendererFullPdfSerialization.requiresLargeFileGuard).toBe(false);
    });

    it('plans dirty repair and optimize requests as serialized rewrites instead of native working-copy persistence', () => {
        const plan = buildPlan({
            forceSerialize: true,
            forceRewrite: true,
            canPersistNativeWorkingCopy: true,
            canAttemptNativeMutationSave: true,
        }, {dirtyState: dirtyState({pendingTexts: true})});

        expect(plan.persistenceRoute).toBe('serialized-rewrite');
        expect(plan.serialization).toMatchObject({
            shouldSerialize: true,
            forcedByDirtyState: true,
            requestedByRepairOrOptimization: true,
            forceRewrite: true,
        });
        expect(plan.rendererFullPdfSerialization.requiresLargeFileGuard).toBe(true);
    });

    it('plans dirty save through native mutations with serialized fallback when native attempts are allowed', () => {
        const plan = buildPlan({canAttemptNativeMutationSave: true}, {dirtyState: dirtyState({pendingTexts: true})});

        expect(plan.persistenceRoute).toBe('native-mutations-or-serialized');
        expect(plan.livePdfjsAnnotationSession.canPreserve).toBe(true);
        expect(plan.rendererFullPdfSerialization.requiresLargeFileGuard).toBe(true);
    });

    it('plans dirty Save As and native-disabled dirty Save as serialized rewrites', () => {
        expect(buildPlan({
            mode: 'save_as',
            shouldPreferWorkingCopy: false,
            canAttemptNativeMutationSave: true,
        }, {dirtyState: dirtyState({pendingTexts: true})}).persistenceRoute).toBe('serialized-rewrite');

        expect(buildPlan({}, {dirtyState: dirtyState({pendingTexts: true})}).persistenceRoute).toBe('serialized-rewrite');
    });

    it('expresses PDF.js materialization and managed-shape live-source flags', () => {
        const plan = buildPlan({canAttemptNativeMutationSave: true}, {
            dirtyState: dirtyState({preservedAnnotationSource: true}),
            hasManagedShapes: true,
        });

        expect(plan.persistenceRoute).toBe('serialized-rewrite');
        expect(plan.pdfjsSourceMaterialization).toEqual({
            required: true,
            forcePdfjsMaterialize: true,
            includeManagedShapesForLiveSource: true,
        });
        expect(plan.livePdfjsAnnotationSession.canPreserve).toBe(true);
    });

    it('plans saved PDF.js baseline changes as materialized serialized rewrites', () => {
        const plan = buildPlan({canAttemptNativeMutationSave: true}, {dirtyState: dirtyState({savedPdfjsAnnotationBaseline: true})});

        expect(plan.persistenceRoute).toBe('serialized-rewrite');
        expect(plan.pdfjsSourceMaterialization).toMatchObject({
            required: true,
            forcePdfjsMaterialize: false,
        });
        expect(plan.livePdfjsAnnotationSession.canPreserve).toBe(false);
    });
});
