import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    effectScope,
    ref,
} from 'vue';
import type { IShutdownSaveFlushResponse } from '@contracts/systemPlatformFeature';
import { useShutdownSaveFlushReporting } from '@app/modules/workspace-shell/composables/useShutdownSaveFlushReporting';

const mocks = vi.hoisted(() => ({warn: vi.fn()}));

vi.mock('@app/utils/browserLogger', () => ({BrowserLogger: {warn: mocks.warn}}));

type TShutdownSaveFlushCallback = () => Promise<IShutdownSaveFlushResponse> | IShutdownSaveFlushResponse;

function createHarness(options: {
    dirty?: boolean;
    workingCopyPath?: string | null;
    saveForExternalRead?: () => Promise<boolean> | boolean;
} = {}) {
    let callback: TShutdownSaveFlushCallback | null = null;
    const unsubscribe = vi.fn();
    const onShutdownSaveFlushRequest = vi.fn((nextCallback: TShutdownSaveFlushCallback) => {
        callback = nextCallback;
        return unsubscribe;
    });
    const systemCapability = {onShutdownSaveFlushRequest};
    const workingCopyPath = ref<string | null>(
        options.workingCopyPath === undefined
            ? '/tmp/document-working-copy.pdf'
            : options.workingCopyPath,
    );
    const hasPendingUnsavedChanges = ref(options.dirty ?? true);
    const saveForExternalRead = vi.fn(options.saveForExternalRead ?? (async () => true));
    const scope = effectScope();

    scope.run(() => {
        useShutdownSaveFlushReporting({
            workingCopyPath,
            hasPendingUnsavedChanges,
            saveForExternalRead,
            systemCapability,
        });
    });

    return {
        hasPendingUnsavedChanges,
        saveForExternalRead,
        scope,
        systemCapability,
        unsubscribe,
        workingCopyPath,
        invoke: async () => {
            expect(callback).toEqual(expect.any(Function));
            return callback ? await callback() : {};
        },
    };
}

describe('useShutdownSaveFlushReporting', () => {
    it('registers and disposes the shutdown save-flush subscriber', () => {
        const harness = createHarness();

        expect(harness.systemCapability.onShutdownSaveFlushRequest).toHaveBeenCalledTimes(1);
        harness.scope.stop();
        expect(harness.unsubscribe).toHaveBeenCalledTimes(1);
    });

    it('flushes a dirty working copy before reporting it safe for shutdown cleanup', async () => {
        const harness = createHarness();

        await expect(harness.invoke()).resolves.toEqual({flushedWorkingCopyPaths: ['/tmp/document-working-copy.pdf']});
        expect(harness.saveForExternalRead).toHaveBeenCalledTimes(1);

        harness.scope.stop();
    });

    it('reports the captured dirty working copy when shutdown save cannot complete', async () => {
        const harness = createHarness({saveForExternalRead: async () => false});

        harness.workingCopyPath.value = '/tmp/document-working-copy-after-registration.pdf';
        await expect(harness.invoke()).resolves.toEqual({dirtyWorkingCopyPaths: ['/tmp/document-working-copy-after-registration.pdf']});
        expect(harness.saveForExternalRead).toHaveBeenCalledTimes(1);

        harness.scope.stop();
    });

    it('preserves a failed dirty materialization and reports its stable outcome code', async () => {
        const error = Object.assign(
            new Error('The original document is unavailable'),
            {code: 'SOURCE_BACKING_UNAVAILABLE'},
        );
        const harness = createHarness({saveForExternalRead: async () => {
            throw error;
        }});

        await expect(harness.invoke()).resolves.toEqual({dirtyWorkingCopyPaths: ['/tmp/document-working-copy.pdf']});
        expect(mocks.warn).toHaveBeenCalledWith(
            'workspace',
            'Failed to flush dirty working copy during shutdown',
            {
                error,
                errorCode: 'SOURCE_BACKING_UNAVAILABLE',
                workingCopyPath: '/tmp/document-working-copy.pdf',
            },
        );

        harness.scope.stop();
    });

    it('leaves clean or unopened documents unreported', async () => {
        const cleanHarness = createHarness({dirty: false});

        await expect(cleanHarness.invoke()).resolves.toEqual({});
        expect(cleanHarness.saveForExternalRead).not.toHaveBeenCalled();
        cleanHarness.scope.stop();

        const unopenedHarness = createHarness({workingCopyPath: null});

        await expect(unopenedHarness.invoke()).resolves.toEqual({});
        expect(unopenedHarness.saveForExternalRead).not.toHaveBeenCalled();
        unopenedHarness.scope.stop();
    });
});
