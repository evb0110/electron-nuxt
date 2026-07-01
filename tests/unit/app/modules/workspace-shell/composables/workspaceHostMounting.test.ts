import {
    describe,
    expect,
    it,
} from 'vitest';
import { resolveWorkspaceRequestedState } from '@app/modules/workspace-shell/host/resolveWorkspaceRequestedState';
import { shouldAutoRequestWorkspace } from '@app/modules/workspace-shell/host/shouldAutoRequestWorkspace';
import { shouldPreloadWorkspaceDuringStartup } from '@app/modules/workspace-shell/host/shouldPreloadWorkspaceDuringStartup';
import { shouldPreloadWorkspaceOnHostMount } from '@app/modules/workspace-shell/host/shouldPreloadWorkspaceOnHostMount';
import { warmupDesktopViewerChunks } from '@app/modules/workspace-shell/host/warmupDesktopViewerChunks';
import { shouldShowWorkspaceHostLoader } from '@app/modules/workspace-shell/host/shouldShowWorkspaceHostLoader';
import { shouldShowWorkspacePlaceholder } from '@app/modules/workspace-shell/host/shouldShowWorkspacePlaceholder';
import { tabHasDocumentHint } from '@app/modules/workspace-shell/tabs/tabHasDocumentHint';

describe('tabHasDocumentHint', () => {
    it('returns false for placeholder tabs', () => {
        expect(tabHasDocumentHint({
            fileName: null,
            originalPath: null,
            isDjvu: false,
        })).toBe(false);
    });

    it('returns true when file name exists', () => {
        expect(tabHasDocumentHint({
            fileName: 'invoice.pdf',
            originalPath: null,
            isDjvu: false,
        })).toBe(true);
    });

    it('returns true when original path exists', () => {
        expect(tabHasDocumentHint({
            fileName: null,
            originalPath: '/docs/invoice.pdf',
            isDjvu: false,
        })).toBe(true);
    });

    it('returns true when tab is in DjVu mode', () => {
        expect(tabHasDocumentHint({
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

    it('skips viewer chunk warmup on the web so visitors never prefetch both engines', () => {
        let loaderCalls = 0;
        const result = warmupDesktopViewerChunks({
            isDesktopRuntime: false,
            loaders: [() => {
                loaderCalls += 1;
                return Promise.resolve();
            }],
        });
        expect(result).toBeNull();
        expect(loaderCalls).toBe(0);
    });

    it('warms every viewer chunk loader on desktop', async () => {
        const loadedChunks: string[] = [];
        const result = warmupDesktopViewerChunks({
            isDesktopRuntime: true,
            loaders: [
                () => {
                    loadedChunks.push('djvu');
                    return Promise.resolve();
                },
                () => {
                    loadedChunks.push('native-pdf');
                    return Promise.resolve();
                },
            ],
        });
        expect(result).not.toBeNull();
        await result;
        expect(loadedChunks).toEqual([
            'djvu',
            'native-pdf',
        ]);
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

describe('workspace host startup visibility', () => {
    const emptyPlaceholderSignals = {
        hasQueuedSplitRestore: false,
        hasPendingDocumentHint: false,
        hasVisibleDocument: false,
        isDocumentOpenInFlight: false,
    };

    it('shows the lightweight empty placeholder while startup open claim is pending', () => {
        expect(shouldShowWorkspacePlaceholder(emptyPlaceholderSignals)).toBe(true);
        expect(shouldShowWorkspaceHostLoader({
            ...emptyPlaceholderSignals,
            hasHostError: false,
            isStartupOpenClaimPending: true,
        })).toBe(false);
    });

    it('keeps the host loader for pending startup work that suppresses the placeholder', () => {
        expect(shouldShowWorkspacePlaceholder({
            ...emptyPlaceholderSignals,
            hasPendingDocumentHint: true,
        })).toBe(false);
        expect(shouldShowWorkspaceHostLoader({
            ...emptyPlaceholderSignals,
            hasHostError: false,
            hasPendingDocumentHint: true,
            isStartupOpenClaimPending: true,
        })).toBe(true);
    });

    it('hides the startup loader once startup open claim settles', () => {
        expect(shouldShowWorkspaceHostLoader({
            ...emptyPlaceholderSignals,
            hasHostError: false,
            hasPendingDocumentHint: true,
            isStartupOpenClaimPending: false,
        })).toBe(false);
    });

    it('does not place the startup loader over host errors', () => {
        expect(shouldShowWorkspaceHostLoader({
            ...emptyPlaceholderSignals,
            hasHostError: true,
            hasPendingDocumentHint: true,
            isStartupOpenClaimPending: true,
        })).toBe(false);
    });
});
