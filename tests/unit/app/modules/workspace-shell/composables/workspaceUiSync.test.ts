import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    nextTick,
    ref,
} from 'vue';
import { useWorkspaceUiSyncWatchers } from '@app/modules/workspace-shell/composables/useWorkspaceUiSyncWatchers';
import { resolveWorkspaceTabUpdate } from '@app/modules/workspace-shell/state/resolveWorkspaceTabUpdate';
import { resolveWorkspaceWindowTitle } from '@app/modules/workspace-shell/state/resolveWorkspaceWindowTitle';

type TWorkspaceUiSyncDeps = Parameters<typeof useWorkspaceUiSyncWatchers>[0];

describe('resolveWorkspaceWindowTitle', () => {
    it('prefers DjVu source filename when in DjVu mode', () => {
        const title = resolveWorkspaceWindowTitle({
            isDjvuMode: true,
            djvuSourcePath: '/docs/archive/my-scan.djvu',
            fileName: 'working-copy.pdf',
            pendingOpenDisplayName: null,
            fallbackTitle: 'EVB Viewer',
        });

        expect(title).toBe('my-scan.djvu');
    });

    it('decodes browser-encoded DjVu source names for the window title', () => {
        const title = resolveWorkspaceWindowTitle({
            isDjvuMode: true,
            djvuSourcePath: 'browser://documents/source/%25D0%2593%25D0%25BB%25D0%25B0%25D0%25B2%25D0%25B0.djvu',
            fileName: 'working-copy.pdf',
            pendingOpenDisplayName: null,
            fallbackTitle: 'EVB Viewer',
        });

        expect(title).toBe('Глава.djvu');
    });

    it('falls back to app title when no file name is available', () => {
        const title = resolveWorkspaceWindowTitle({
            isDjvuMode: false,
            djvuSourcePath: null,
            fileName: null,
            pendingOpenDisplayName: null,
            fallbackTitle: 'EVB Viewer',
        });

        expect(title).toBe('EVB Viewer');
    });
});

describe('resolveWorkspaceTabUpdate', () => {
    it('emits DjVu source path as tab originalPath when DjVu mode is active', () => {
        const update = resolveWorkspaceTabUpdate({
            fileName: 'temp.pdf',
            pendingOpenDisplayName: null,
            originalPath: '/tmp/temp.pdf',
            isDirty: true,
            isDjvuMode: true,
            djvuSourcePath: '/docs/source/book.djvu',
        });

        expect(update).toEqual({
            fileName: 'book.djvu',
            originalPath: '/docs/source/book.djvu',
            isDirty: true,
            isDjvu: true,
        });
    });

    it('decodes browser-encoded DjVu source names for the tab label', () => {
        const update = resolveWorkspaceTabUpdate({
            fileName: 'temp.pdf',
            pendingOpenDisplayName: null,
            originalPath: 'browser://documents/working/temp.pdf',
            isDirty: true,
            isDjvuMode: true,
            djvuSourcePath: 'browser://documents/source/%25D0%2593%25D0%25BB%25D0%25B0%25D0%25B2%25D0%25B0.djvu',
        });

        expect(update).toEqual({
            fileName: 'Глава.djvu',
            originalPath: 'browser://documents/source/%25D0%2593%25D0%25BB%25D0%25B0%25D0%25B2%25D0%25B0.djvu',
            isDirty: true,
            isDjvu: true,
        });
    });

    it('keeps PDF metadata when DjVu mode is inactive', () => {
        const update = resolveWorkspaceTabUpdate({
            fileName: 'paper.pdf',
            pendingOpenDisplayName: null,
            originalPath: '/docs/paper.pdf',
            isDirty: false,
            isDjvuMode: false,
            djvuSourcePath: '/docs/source/book.djvu',
        });

        expect(update).toEqual({
            fileName: 'paper.pdf',
            originalPath: '/docs/paper.pdf',
            isDirty: false,
            isDjvu: false,
        });
    });
});

function createWatcherDeps(overrides: Partial<TWorkspaceUiSyncDeps> = {}): TWorkspaceUiSyncDeps {
    return {
        showSettings: ref(false),
        emitOpenSettings: (vi.fn() as TWorkspaceUiSyncDeps['emitOpenSettings']),
        ...overrides,
    };
}

describe('useWorkspaceUiSyncWatchers', () => {
    it('forwards settings requests and clears the local flag', async () => {
        const deps = createWatcherDeps();
        useWorkspaceUiSyncWatchers(deps);

        deps.showSettings.value = true;
        await nextTick();

        expect(deps.emitOpenSettings).toHaveBeenCalledTimes(1);
        expect(deps.showSettings.value).toBe(false);
    });
});
