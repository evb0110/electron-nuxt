import {
    afterAll,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const toastAddMock = vi.fn();
vi.stubGlobal('useTypedI18n', () => ({t: (key: string) => key}));
vi.stubGlobal('useToast', () => ({add: toastAddMock}));

const { useWorkspaceFailureSurface } = await import(
    '@app/modules/workspace-shell/composables/useWorkspaceFailureSurface'
);

// The composable resolves both globals on every call, so the stubs have to
// outlive each test and are dropped once for the file.
afterAll(() => {
    vi.unstubAllGlobals();
});

describe('useWorkspaceFailureSurface', () => {
    beforeEach(() => {
        toastAddMock.mockClear();
    });

    it('shows one toast when a low-level failure and a service result share an operation', () => {
        const surface = useWorkspaceFailureSurface();

        expect(surface.reportSaveFailure('save-1', 'validation-rejected')).toBe(true);
        expect(surface.reportSaveFailure('save-1', 'persist-rejected')).toBe(false);

        expect(toastAddMock).toHaveBeenCalledOnce();
        expect(toastAddMock).toHaveBeenCalledWith(expect.objectContaining({
            color: 'error',
            title: 'errors.file.save',
            description: 'errors.save.validation',
        }));
        expect(surface.hasSaveFailure.value).toBe(true);
    });

    it('toasts again for a separate operation', () => {
        const surface = useWorkspaceFailureSurface();

        surface.reportSaveFailure('save-1', 'validation-rejected');
        surface.reportSaveFailure('save-2', 'validation-rejected');

        expect(toastAddMock).toHaveBeenCalledTimes(2);
    });

    it('prefers a caller-supplied detail over the reason copy', () => {
        const surface = useWorkspaceFailureSurface();

        surface.reportSaveFailure('save-1', 'unexpected-error', 'disk exploded');

        expect(toastAddMock).toHaveBeenCalledWith(expect.objectContaining({description: 'disk exploded'}));
    });

    it('drops the durable state when the save domain is cleared', () => {
        const surface = useWorkspaceFailureSurface();

        surface.reportSaveFailure('save-1', 'persist-rejected');
        expect(surface.hasSaveFailure.value).toBe(true);

        surface.clearSaveFailure();

        expect(surface.hasSaveFailure.value).toBe(false);
    });

    it('re-toasts an operation id that repeats after a clear', () => {
        const surface = useWorkspaceFailureSurface();

        surface.reportSaveFailure('save-1', 'persist-rejected');
        surface.clearSaveFailure();

        expect(surface.reportSaveFailure('save-1', 'persist-rejected')).toBe(true);
        expect(toastAddMock).toHaveBeenCalledTimes(2);
    });

    it('tells the user about a superseded save without keeping it against the next document', () => {
        const surface = useWorkspaceFailureSurface();

        expect(surface.reportSaveFailure('save-1', 'document-changed')).toBe(true);

        expect(toastAddMock).toHaveBeenCalledWith(expect.objectContaining({description: 'errors.save.documentChanged'}));
        expect(surface.hasSaveFailure.value).toBe(false);
    });

    it('keeps a rejected annotation out of the save state', () => {
        const surface = useWorkspaceFailureSurface();

        expect(surface.reportAnnotationFailure({
            operationId: 'annotation-create-1',
            reason: 'selection-spans-pages',
        })).toBe(true);

        expect(toastAddMock).toHaveBeenCalledWith(expect.objectContaining({
            color: 'error',
            title: 'errors.annotation.create',
            description: 'errors.annotation.selectionSpansPages',
        }));
        expect(surface.hasSaveFailure.value).toBe(false);
    });

    it('separates annotation and save deduplication', () => {
        const surface = useWorkspaceFailureSurface();

        surface.reportSaveFailure('op-1', 'persist-rejected');
        surface.reportAnnotationFailure({
            operationId: 'op-1',
            reason: 'selection-spans-pages',
        });

        expect(toastAddMock).toHaveBeenCalledTimes(2);
    });

    it('stays silent for annotation reasons that are ordinary no-ops', () => {
        const surface = useWorkspaceFailureSurface();

        expect(surface.reportAnnotationFailure({
            operationId: 'annotation-create-1',
            reason: 'no-selection',
        })).toBe(false);
        expect(surface.reportAnnotationFailure({
            operationId: 'annotation-create-2',
            reason: 'editor-unavailable',
        })).toBe(false);
        expect(surface.reportAnnotationFailure({
            operationId: 'annotation-create-3',
            reason: 'selection-not-in-text-layer',
        })).toBe(false);

        expect(toastAddMock).not.toHaveBeenCalled();
    });

    it('toasts the shared title with no detail for reasons the user cannot act on', () => {
        const surface = useWorkspaceFailureSurface();

        expect(surface.reportAnnotationFailure({
            operationId: 'annotation-create-1',
            reason: 'mode-switch-failed',
        })).toBe(true);

        expect(toastAddMock).toHaveBeenCalledWith({
            color: 'error',
            title: 'errors.annotation.create',
        });
    });
});
