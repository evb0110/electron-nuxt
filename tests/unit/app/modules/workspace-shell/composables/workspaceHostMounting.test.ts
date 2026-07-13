import {
    describe,
    expect,
    it,
} from 'vitest';
import { resolveWorkspaceRequestedState } from '@app/modules/workspace-shell/host/resolveWorkspaceRequestedState';
import { shouldAutoRequestWorkspace } from '@app/modules/workspace-shell/host/shouldAutoRequestWorkspace';
import { shouldPreloadWorkspaceDuringStartup } from '@app/modules/workspace-shell/host/shouldPreloadWorkspaceDuringStartup';
import { shouldPreloadWorkspaceOnHostMount } from '@app/modules/workspace-shell/host/shouldPreloadWorkspaceOnHostMount';
import { preloadStartupDocumentOpenChunks } from '@app/modules/workspace-shell/host/preloadStartupDocumentOpenChunks';
import { scheduleActiveEmptyWorkspacePremount } from '@app/modules/workspace-shell/host/scheduleActiveEmptyWorkspacePremount';
import {
    getWorkspaceViewerChunkTargetsForPaths,
    warmupDesktopViewerChunkForPaths,
    warmupDesktopViewerChunks,
} from '@app/modules/workspace-shell/host/warmupDesktopViewerChunks';
import type {
    TWorkspaceViewerChunkLoader,
    TWorkspaceViewerChunkTarget,
} from '@app/modules/workspace-shell/viewers/workspaceViewerChunkLoaders';
import { shouldShowWorkspaceHostLoader } from '@app/modules/workspace-shell/host/shouldShowWorkspaceHostLoader';
import { shouldShowWorkspacePlaceholder } from '@app/modules/workspace-shell/host/shouldShowWorkspacePlaceholder';
import { tabHasDocumentHint } from '@app/modules/workspace-shell/tabs/tabHasDocumentHint';

function createRecordingViewerChunkLoaders(loadedChunks: string[]) {
    const record = (target: TWorkspaceViewerChunkTarget) => () => {
        loadedChunks.push(target);
        return Promise.resolve();
    };
    return {
        chassis: record('chassis'),
        pdfjs: record('pdfjs'),
        'native-pdf': record('native-pdf'),
        'page-source': record('page-source'),
    } satisfies Record<TWorkspaceViewerChunkTarget, TWorkspaceViewerChunkLoader>;
}

function createAnimationFrameHost() {
    let nextHandle = 1;
    const callbacks = new Map<number, FrameRequestCallback>();
    return {
        host: {
            requestAnimationFrame(callback: FrameRequestCallback) {
                const handle = nextHandle;
                nextHandle += 1;
                callbacks.set(handle, callback);
                return handle;
            },
            cancelAnimationFrame(handle: number) {
                callbacks.delete(handle);
            },
        },
        runFrame() {
            const pending = [...callbacks.values()];
            callbacks.clear();
            pending.forEach(callback => callback(0));
        },
        pendingCount: () => callbacks.size,
    };
}

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
    it('opens the active-empty premount gate only after one committed paint', () => {
        const animationFrames = createAnimationFrameHost();
        let ready = false;
        scheduleActiveEmptyWorkspacePremount(() => { ready = true; }, animationFrames.host);

        expect(animationFrames.pendingCount()).toBe(1);
        animationFrames.runFrame();
        expect(ready).toBe(false);
        expect(animationFrames.pendingCount()).toBe(1);
        animationFrames.runFrame();
        expect(ready).toBe(true);
    });

    it('cancels active-empty premount work with the host lifecycle', () => {
        const animationFrames = createAnimationFrameHost();
        let ready = false;
        const cancel = scheduleActiveEmptyWorkspacePremount(() => { ready = true; }, animationFrames.host);

        animationFrames.runFrame();
        cancel();
        animationFrames.runFrame();
        expect(ready).toBe(false);
        expect(animationFrames.pendingCount()).toBe(0);
    });

    it('requests mount when split restore is queued', () => {
        expect(shouldAutoRequestWorkspace({
            hasQueuedSplitRestore: true,
            hasDocumentHint: false,
            isActive: false,
            canPremountActiveEmpty: false,
        })).toBe(true);
    });

    it('waits to mount inactive tabs with only a document hint', () => {
        expect(shouldAutoRequestWorkspace({
            hasQueuedSplitRestore: false,
            hasDocumentHint: true,
            isActive: false,
            canPremountActiveEmpty: true,
        })).toBe(false);
    });

    it('requests mount when an active tab has a document hint', () => {
        expect(shouldAutoRequestWorkspace({
            hasQueuedSplitRestore: false,
            hasDocumentHint: true,
            isActive: true,
            canPremountActiveEmpty: false,
        })).toBe(true);
    });

    it('mounts the real workspace viewport behind an active empty tab only after its first paint', () => {
        expect(shouldAutoRequestWorkspace({
            hasQueuedSplitRestore: false,
            hasDocumentHint: false,
            isActive: true,
            canPremountActiveEmpty: false,
        })).toBe(false);
        expect(shouldAutoRequestWorkspace({
            hasQueuedSplitRestore: false,
            hasDocumentHint: false,
            isActive: true,
            canPremountActiveEmpty: true,
        })).toBe(true);
    });

    it('keeps request latched after signals clear', () => {
        const requested = resolveWorkspaceRequestedState(true, {
            hasQueuedSplitRestore: false,
            hasDocumentHint: false,
            isActive: false,
            canPremountActiveEmpty: false,
        });
        expect(requested).toBe(true);
    });

    it('stays false when not requested and no signals are present', () => {
        const requested = resolveWorkspaceRequestedState(false, {
            hasQueuedSplitRestore: false,
            hasDocumentHint: false,
            isActive: false,
            canPremountActiveEmpty: true,
        });
        expect(requested).toBe(false);
    });

    it('requests a hinted workspace when its tab becomes active', () => {
        const requested = resolveWorkspaceRequestedState(false, {
            hasQueuedSplitRestore: false,
            hasDocumentHint: true,
            isActive: true,
            canPremountActiveEmpty: false,
        });
        expect(requested).toBe(true);
    });
});

describe('workspace preload policy', () => {
    it('keeps the desktop document workspace inside startup readiness in production and dev', () => {
        expect(shouldPreloadWorkspaceDuringStartup({
            isDesktopRuntime: true,
            isDev: false,
            routePreloadWorkspaceShell: false,
        })).toBe(true);
        expect(shouldPreloadWorkspaceDuringStartup({
            isDesktopRuntime: true,
            isDev: true,
            routePreloadWorkspaceShell: false,
        })).toBe(true);
    });

    it('respects route-level startup workspace preload opt-out on the web', () => {
        expect(shouldPreloadWorkspaceDuringStartup({
            isDesktopRuntime: false,
            isDev: true,
            routePreloadWorkspaceShell: false,
        })).toBe(false);
    });

    it('preloads during startup when the route does not opt out', () => {
        expect(shouldPreloadWorkspaceDuringStartup({
            isDesktopRuntime: false,
            isDev: false,
        })).toBe(true);
    });

    it('skips viewer chunk warmup on the web so visitors never prefetch both engines', () => {
        const loadedChunks: string[] = [];
        const result = warmupDesktopViewerChunks({
            isDesktopRuntime: false,
            loaderOverrides: createRecordingViewerChunkLoaders(loadedChunks),
        });
        expect(result).toBeNull();
        expect(loadedChunks).toEqual([]);
    });

    it('awaits every cold Recent-file viewer boundary before desktop startup becomes interactive', async () => {
        const loadedChunks: string[] = [];
        const workspaceLoader = () => {
            loadedChunks.push('workspace');
            return Promise.resolve();
        };
        const preload = preloadStartupDocumentOpenChunks({
            isDesktopRuntime: true,
            shouldPreloadWorkspace: true,
            workspaceLoader,
            viewerLoaderOverrides: createRecordingViewerChunkLoaders(loadedChunks),
        });

        expect(preload).not.toBeNull();
        await preload;
        expect(loadedChunks).toEqual([
            'workspace',
            'chassis',
            'pdfjs',
            'native-pdf',
            'page-source',
        ]);
    });

    it('preserves the web bundle policy while retaining workspace preload where requested', async () => {
        const loadedChunks: string[] = [];
        const workspaceLoader = () => {
            loadedChunks.push('workspace');
            return Promise.resolve();
        };
        const preload = preloadStartupDocumentOpenChunks({
            isDesktopRuntime: false,
            shouldPreloadWorkspace: true,
            workspaceLoader,
            viewerLoaderOverrides: createRecordingViewerChunkLoaders(loadedChunks),
        });

        await preload;
        expect(loadedChunks).toEqual(['workspace']);
        expect(preloadStartupDocumentOpenChunks({
            isDesktopRuntime: false,
            shouldPreloadWorkspace: false,
            workspaceLoader,
            viewerLoaderOverrides: createRecordingViewerChunkLoaders(loadedChunks),
        })).toBeNull();
    });

    it('warms every viewer chunk loader on desktop', async () => {
        const loadedChunks: string[] = [];
        const result = warmupDesktopViewerChunks({
            isDesktopRuntime: true,
            loaderOverrides: createRecordingViewerChunkLoaders(loadedChunks),
        });
        expect(result).not.toBeNull();
        await result;
        expect(loadedChunks).toEqual([
            'chassis',
            'pdfjs',
            'native-pdf',
            'page-source',
        ]);
    });

    it('keeps prioritized default targets aligned with every async boundary a PDF may mount', async () => {
        const loadedChunks: string[] = [];
        const result = warmupDesktopViewerChunkForPaths({
            isDesktopRuntime: true,
            paths: [
                '/docs/book.pdf?from=recent',
                '/docs/notes.PDF',
            ],
            loaderOverrides: createRecordingViewerChunkLoaders(loadedChunks),
        });
        await result;
        expect(loadedChunks).toEqual([
            'chassis',
            'pdfjs',
            'native-pdf',
        ]);
        expect(getWorkspaceViewerChunkTargetsForPaths(['/docs/book.pdf'])).toEqual(loadedChunks);
    });

    it('keeps prioritized default targets aligned with every async boundary DjVu mounts', async () => {
        expect(getWorkspaceViewerChunkTargetsForPaths([
            '/docs/book.djvu',
            '/docs/notes.DJV',
        ])).toEqual([
            'chassis',
            'page-source',
        ]);
    });

    it('deduplicates the shared chassis while warming mixed pending paths', () => {
        expect(getWorkspaceViewerChunkTargetsForPaths([
            '/docs/book.djvu',
            '/docs/notes.pdf',
        ])).toEqual([
            'chassis',
            'pdfjs',
            'native-pdf',
            'page-source',
        ]);
    });

    it('leaves active empty host mounting to the post-paint premount in every build', () => {
        expect(shouldPreloadWorkspaceOnHostMount({
            hasQueuedSplitRestore: false,
            hasDocumentHint: false,
            isActive: true,
        })).toBe(false);
        expect(shouldPreloadWorkspaceOnHostMount({
            hasQueuedSplitRestore: false,
            hasDocumentHint: false,
            isActive: true,
        })).toBe(false);
    });

    it('keeps immediate host preload for queued restores and active document work', () => {
        expect(shouldPreloadWorkspaceOnHostMount({
            hasQueuedSplitRestore: true,
            hasDocumentHint: false,
            isActive: false,
        })).toBe(true);
        expect(shouldPreloadWorkspaceOnHostMount({
            hasQueuedSplitRestore: false,
            hasDocumentHint: true,
            isActive: true,
        })).toBe(true);
    });

    it('skips host mount preload for inactive document and production placeholder tabs', () => {
        expect(shouldPreloadWorkspaceOnHostMount({
            hasQueuedSplitRestore: false,
            hasDocumentHint: true,
            isActive: false,
        })).toBe(false);
        expect(shouldPreloadWorkspaceOnHostMount({
            hasQueuedSplitRestore: false,
            hasDocumentHint: false,
            isActive: false,
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

    it('retains the committed empty placeholder while a hinted document has not committed', () => {
        expect(shouldShowWorkspacePlaceholder({
            ...emptyPlaceholderSignals,
            hasPendingDocumentHint: true,
            isDocumentOpenInFlight: true,
        })).toBe(true);
        expect(shouldShowWorkspaceHostLoader({
            ...emptyPlaceholderSignals,
            hasHostError: false,
            hasPendingDocumentHint: true,
            isStartupOpenClaimPending: true,
        })).toBe(false);
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
