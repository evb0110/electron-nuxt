import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    ref,
    shallowRef,
} from 'vue';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import {
    createFileOperationsSaveCompletion,
    type IFileOperationsSaveCompletionPorts,
} from '@app/modules/workspace-shell/composables/file-operations/createFileOperationsSaveCompletion';
import { cast } from '@tests/helpers/cast';

function createPersistResult() {
    return {
        success: true,
        outPath: '/tmp/work.pdf',
        saveMode: 'rewrite' as const,
        didSaveAs: false,
    };
}

function createCompletionPorts(overrides: {
    annotationToken?: () => unknown;
    bookmarkToken?: () => unknown;
    pageLabelToken?: () => unknown;
} = {}) {
    const resetModified = vi.fn();
    const ports: IFileOperationsSaveCompletionPorts = {
        state: {
            annotations: {
                annotationDirty: ref(false),
                annotationComments: ref([]),
                markAnnotationSaved: vi.fn(),
                getAnnotationSaveStateToken: overrides.annotationToken ?? vi.fn(() => 'annotation-token'),
                hasAnnotationChanges: vi.fn(() => false),
            },
            metadata: {
                pageLabelsDirty: ref(false),
                bookmarksDirty: ref(false),
            },
            metadataCompletion: {
                markPageLabelsSaved: vi.fn(),
                getPageLabelsSaveStateToken: overrides.pageLabelToken ?? vi.fn(() => 'page-label-token'),
                markBookmarksSaved: vi.fn(),
                getBookmarksSaveStateToken: overrides.bookmarkToken ?? vi.fn(() => 'bookmark-token'),
            },
        },
        pdf: {source: {
            pdfDocument: shallowRef<PDFDocumentProxy | null>(cast({annotationStorage: {resetModified}})),
            saveDocument: vi.fn(async () => new Uint8Array([1])),
            getSourcePdfData: vi.fn(async () => new Uint8Array([1])),
        }},
        viewer: {
            shapes: {hasShapeChanges: vi.fn(() => false)},
            shapeState: {
                markShapeStateSaved: vi.fn(),
                adoptPersistedShapeStateForNextReload: vi.fn(),
                clearPendingPersistedShapeStateForNextReload: vi.fn(),
            },
        },
        lifecycle: {loadRecentFiles: vi.fn()},
    };
    return {
        ports,
        resetModified,
    };
}

function createReloadWaiter() {
    return {
        promise: Promise.resolve(),
        cancel: vi.fn(),
    };
}

describe('createFileOperationsSaveCompletion', () => {
    it('marks unchanged save-state baselines, resets live annotation storage, and refreshes recent files', () => {
        const {
            ports,
            resetModified,
        } = createCompletionPorts();
        const completion = createFileOperationsSaveCompletion(ports);
        const snapshot = completion.captureSaveStateSnapshot();

        expect(completion.finalizeSuccessfulSave(createPersistResult(), {saveStateSnapshot: snapshot})).toBe(true);

        expect(resetModified).toHaveBeenCalledOnce();
        expect(ports.state.annotations.markAnnotationSaved).toHaveBeenCalledWith({preserveLivePdfjsSession: false});
        expect(ports.state.metadataCompletion.markPageLabelsSaved).toHaveBeenCalledOnce();
        expect(ports.state.metadataCompletion.markBookmarksSaved).toHaveBeenCalledOnce();
        expect(ports.viewer.shapeState.markShapeStateSaved).toHaveBeenCalledOnce();
        expect(ports.viewer.shapeState.clearPendingPersistedShapeStateForNextReload).toHaveBeenCalledOnce();
        expect(ports.lifecycle.loadRecentFiles).toHaveBeenCalledOnce();
    });

    it('keeps newer baseline tokens dirty unless the save path allows a refresh', () => {
        let annotationToken = 'before';
        const {
            ports,
            resetModified,
        } = createCompletionPorts({annotationToken: () => annotationToken});
        const completion = createFileOperationsSaveCompletion(ports);
        const snapshot = completion.captureSaveStateSnapshot();
        annotationToken = 'after-native-save';

        completion.finalizeSuccessfulSave(createPersistResult(), {saveStateSnapshot: snapshot});

        expect(resetModified).not.toHaveBeenCalled();
        expect(ports.state.annotations.markAnnotationSaved).not.toHaveBeenCalled();

        completion.finalizeSuccessfulSave(createPersistResult(), {
            allowAnnotationSaveStateRefresh: true,
            preserveLivePdfjsSession: true,
            saveStateSnapshot: snapshot,
        });

        expect(resetModified).toHaveBeenCalledOnce();
        expect(ports.state.annotations.markAnnotationSaved).toHaveBeenCalledWith({preserveLivePdfjsSession: true});
    });

    it('clears pending shape adoption and cancels reload on save failure', async () => {
        const { ports } = createCompletionPorts();
        const completion = createFileOperationsSaveCompletion(ports);
        const reloadWaiter = createReloadWaiter();

        await completion.finalizeSaveReload(reloadWaiter, false);

        expect(reloadWaiter.cancel).toHaveBeenCalledOnce();
        expect(ports.viewer.shapeState.clearPendingPersistedShapeStateForNextReload).toHaveBeenCalledOnce();
        expect(ports.state.annotations.markAnnotationSaved).not.toHaveBeenCalled();
    });

    it('completes save state after a successful reload when requested', async () => {
        const {
            ports,
            resetModified,
        } = createCompletionPorts();
        const completion = createFileOperationsSaveCompletion(ports);

        await completion.finalizeSaveReload(createReloadWaiter(), true, {
            completeSaveStateOnSuccess: true,
            markShapeStateSavedOnSuccess: true,
            resetAnnotationStorageOnSuccess: false,
            saveStateSnapshot: completion.captureSaveStateSnapshot(),
        });

        expect(resetModified).not.toHaveBeenCalled();
        expect(ports.state.annotations.markAnnotationSaved).toHaveBeenCalledOnce();
        expect(ports.viewer.shapeState.markShapeStateSaved).toHaveBeenCalledOnce();
    });
});
