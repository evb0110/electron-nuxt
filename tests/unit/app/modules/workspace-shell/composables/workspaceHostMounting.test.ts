import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    hasDocumentMountHint,
    resolveWorkspaceRequestedState,
    shouldAutoRequestWorkspace,
    shouldPreloadWorkspaceDuringStartup,
    shouldPreloadWorkspaceOnHostMount,
} from '@app/modules/workspace-shell/composables/workspaceHostMounting';

describe('hasDocumentMountHint', () => {
    it('returns false for placeholder tabs', () => {
        expect(hasDocumentMountHint({
            fileName: null,
            originalPath: null,
            isDjvu: false,
        })).toBe(false);
    });

    it('returns true when file name exists', () => {
        expect(hasDocumentMountHint({
            fileName: 'invoice.pdf',
            originalPath: null,
            isDjvu: false,
        })).toBe(true);
    });

    it('returns true when original path exists', () => {
        expect(hasDocumentMountHint({
            fileName: null,
            originalPath: '/docs/invoice.pdf',
            isDjvu: false,
        })).toBe(true);
    });

    it('returns true when tab is in DjVu mode', () => {
        expect(hasDocumentMountHint({
            fileName: null,
            originalPath: null,
            isDjvu: true,
        })).toBe(true);
    });
});

describe('workspace host mount request state', () => {
    it('requests mount when split restore is queued', () => {
        expect(shouldAutoRequestWorkspace({
            hasQueuedSplitRestore: true,
            hasDocumentHint: false,
            isActive: false,
        })).toBe(true);
    });

    it('waits to mount inactive tabs with only a document hint', () => {
        expect(shouldAutoRequestWorkspace({
            hasQueuedSplitRestore: false,
            hasDocumentHint: true,
            isActive: false,
        })).toBe(false);
    });

    it('requests mount when an active tab has a document hint', () => {
        expect(shouldAutoRequestWorkspace({
            hasQueuedSplitRestore: false,
            hasDocumentHint: true,
            isActive: true,
        })).toBe(true);
    });

    it('keeps empty active tabs on the lightweight placeholder shell', () => {
        expect(shouldAutoRequestWorkspace({
            hasQueuedSplitRestore: false,
            hasDocumentHint: false,
            isActive: true,
        })).toBe(false);
    });

    it('keeps request latched after signals clear', () => {
        const requested = resolveWorkspaceRequestedState(true, {
            hasQueuedSplitRestore: false,
            hasDocumentHint: false,
            isActive: false,
        });
        expect(requested).toBe(true);
    });

    it('stays false when not requested and no signals are present', () => {
        const requested = resolveWorkspaceRequestedState(false, {
            hasQueuedSplitRestore: false,
            hasDocumentHint: false,
            isActive: false,
        });
        expect(requested).toBe(false);
    });

    it('requests a hinted workspace when its tab becomes active', () => {
        const requested = resolveWorkspaceRequestedState(false, {
            hasQueuedSplitRestore: false,
            hasDocumentHint: true,
            isActive: true,
        });
        expect(requested).toBe(true);
    });
});

describe('workspace preload policy', () => {
    it('respects route-level startup workspace preload opt-out outside dev desktop', () => {
        expect(shouldPreloadWorkspaceDuringStartup({
            isDesktopRuntime: true,
            isDev: false,
            routePreloadWorkspaceShell: false,
        })).toBe(false);
        expect(shouldPreloadWorkspaceDuringStartup({
            isDesktopRuntime: false,
            isDev: true,
            routePreloadWorkspaceShell: false,
        })).toBe(false);
    });

    it('keeps dev desktop workspace warmup inside startup even when the route opts out', () => {
        expect(shouldPreloadWorkspaceDuringStartup({
            isDesktopRuntime: true,
            isDev: true,
            routePreloadWorkspaceShell: false,
        })).toBe(true);
    });

    it('preloads during startup when the route does not opt out', () => {
        expect(shouldPreloadWorkspaceDuringStartup({
            isDesktopRuntime: false,
            isDev: false,
        })).toBe(true);
    });

    it('skips empty host mount preload in dev after startup warmup', () => {
        expect(shouldPreloadWorkspaceOnHostMount({
            hasQueuedSplitRestore: false,
            hasDocumentHint: false,
            isActive: true,
            isDev: true,
        })).toBe(false);
    });

    it('keeps host mount preload for active production empty tabs and active document work', () => {
        expect(shouldPreloadWorkspaceOnHostMount({
            hasQueuedSplitRestore: false,
            hasDocumentHint: false,
            isActive: true,
            isDev: false,
        })).toBe(true);
        expect(shouldPreloadWorkspaceOnHostMount({
            hasQueuedSplitRestore: true,
            hasDocumentHint: false,
            isActive: false,
            isDev: true,
        })).toBe(true);
        expect(shouldPreloadWorkspaceOnHostMount({
            hasQueuedSplitRestore: false,
            hasDocumentHint: true,
            isActive: true,
            isDev: true,
        })).toBe(true);
    });

    it('skips host mount preload for inactive document and production placeholder tabs', () => {
        expect(shouldPreloadWorkspaceOnHostMount({
            hasQueuedSplitRestore: false,
            hasDocumentHint: true,
            isActive: false,
            isDev: false,
        })).toBe(false);
        expect(shouldPreloadWorkspaceOnHostMount({
            hasQueuedSplitRestore: false,
            hasDocumentHint: false,
            isActive: false,
            isDev: false,
        })).toBe(false);
    });
});
