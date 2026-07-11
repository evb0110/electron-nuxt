import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { handleDocumentWorkspaceCrash } from '@app/modules/workspace-shell/checkpoint/handleDocumentWorkspaceCrash';

const loggerError = vi.hoisted(() => vi.fn());
vi.mock('@app/utils/browserLogger', () => ({BrowserLogger: {error: loggerError}}));

describe('handleDocumentWorkspaceCrash', () => {
    it('fails active work, releases the viewer, resets loading, and exposes the tab error', () => {
        const error = new Error('viewer failed');
        const failActiveTransaction = vi.fn();
        const releaseWorkspace = vi.fn();
        const resetWorkspaceLoad = vi.fn();
        const setError = vi.fn();

        handleDocumentWorkspaceCrash(error, 'PdfViewer', 'render', {
            tabId: 'tab-7',
            failActiveTransaction,
            releaseWorkspace,
            resetWorkspaceLoad,
            setError,
        });

        expect(failActiveTransaction).toHaveBeenCalledOnce();
        expect(releaseWorkspace).toHaveBeenCalledOnce();
        expect(resetWorkspaceLoad).toHaveBeenCalledOnce();
        expect(setError).toHaveBeenCalledWith(error);
        expect(loggerError).toHaveBeenCalledWith(
            'workspace-host',
            'Document tab crashed; isolating the failed workspace',
            expect.objectContaining({
                tabId: 'tab-7',
                component: 'PdfViewer',
            }),
        );
    });
});
