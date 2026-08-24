import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { createWorkspaceDocumentController } from '@app/modules/workspace-shell/document-sessions/workspaceDocumentController';
import type {
    ICloseFileFromUiOptions,
    IWorkspaceExpose,
} from '@app/types/workspaceExpose';
import { cast } from '@tests/helpers/cast';

describe('WorkspaceDocumentController transaction queue', () => {
    it('starts an idle open synchronously and serializes later opens', async () => {
        const controller = createWorkspaceDocumentController({tabId: 'tab-1'});
        const firstGate = Promise.withResolvers<undefined>();
        const events: string[] = [];

        const first = controller.open({
            action: 'first-open',
            target: null,
        }, async () => {
            events.push('first-start');
            await firstGate.promise;
            events.push('first-end');
            return true;
        });
        const second = controller.open({
            action: 'second-open',
            target: null,
        }, async () => {
            events.push('second-start');
            return true;
        });

        expect(events).toEqual(['first-start']);
        firstGate.resolve(undefined);
        await Promise.all([
            first,
            second,
        ]);
        expect(events).toEqual([
            'first-start',
            'first-end',
            'second-start',
        ]);
    });

    it('releases a later open when the active source stage exceeds its deadline', async () => {
        vi.useFakeTimers();
        try {
            const controller = createWorkspaceDocumentController({tabId: 'tab-1'});
            const firstSignals: AbortSignal[] = [];
            const secondRun = vi.fn(async () => true);

            const first = controller.open({
                action: 'first-open',
                target: null,
            }, (signal) => {
                firstSignals.push(signal);
                return new Promise<boolean>(() => undefined);
            });
            const second = controller.open({
                action: 'second-open',
                target: null,
            }, secondRun);

            await vi.advanceTimersByTimeAsync(119_999);
            expect(secondRun).not.toHaveBeenCalled();

            await vi.advanceTimersByTimeAsync(1);
            await expect(Promise.all([
                first,
                second,
            ])).resolves.toEqual([
                false,
                true,
            ]);
            expect(secondRun).toHaveBeenCalledOnce();
            expect(firstSignals.at(0)?.aborted).toBe(true);
            expect(firstSignals.at(0)?.reason).toMatchObject({
                name: 'TimeoutError',
                message: 'Document open source stage timed out',
            });
        } finally {
            vi.useRealTimers();
        }
    });

    it('preempts an active open so close is never queued behind first paint', async () => {
        const controller = createWorkspaceDocumentController({tabId: 'tab-1'});
        const openGate = Promise.withResolvers<undefined>();
        const events: string[] = [];
        controller.attachWorkspace(cast<IWorkspaceExpose>({handleCloseFileFromUi: async (options?: ICloseFileFromUiOptions) => {
            options?.onCloseCommit?.();
            events.push('close');
            return true;
        }}));

        const open = controller.open({
            action: 'open-recent',
            target: null,
        }, async () => {
            events.push('open-start');
            await openGate.promise;
            events.push('open-end');
            return true;
        });
        const close = controller.close({persist: false});

        expect(events).toEqual([
            'open-start',
            'close',
        ]);
        await expect(close).resolves.toBe(true);
        await expect(open).resolves.toBe(false);
        openGate.resolve(undefined);
        await Promise.resolve();
        expect(events).toEqual([
            'open-start',
            'close',
            'open-end',
        ]);
        expect(controller.snapshot.value.phase).toBe('empty');
    });

    it('drops opens that were queued before a close preempted the active open', async () => {
        const controller = createWorkspaceDocumentController({tabId: 'tab-1'});
        const firstGate = Promise.withResolvers<undefined>();
        const secondRun = vi.fn(async () => true);
        controller.attachWorkspace(cast<IWorkspaceExpose>({handleCloseFileFromUi: async (options?: ICloseFileFromUiOptions) => {
            options?.onCloseCommit?.();
            return true;
        }}));

        const first = controller.open({
            action: 'first-open',
            target: null,
        }, async () => {
            await firstGate.promise;
            return true;
        });
        const second = controller.open({
            action: 'second-open',
            target: null,
        }, secondRun);

        await expect(controller.close({persist: false})).resolves.toBe(true);
        await expect(Promise.all([
            first,
            second,
        ])).resolves.toEqual([
            false,
            false,
        ]);
        expect(secondRun).not.toHaveBeenCalled();

        firstGate.resolve(undefined);
    });

    it('does not cancel an active open when close fails its persistence gate', async () => {
        const controller = createWorkspaceDocumentController({tabId: 'tab-1'});
        const openGate = Promise.withResolvers<undefined>();
        controller.attachWorkspace(cast<IWorkspaceExpose>({handleCloseFileFromUi: async () => false}));

        const open = controller.open({
            action: 'open-recent',
            target: null,
        }, async () => {
            await openGate.promise;
            return true;
        });
        const close = controller.close({persist: true});

        await expect(close).resolves.toBe(false);
        expect(controller.snapshot.value.phase).toBe('opening');

        openGate.resolve(undefined);
        await expect(open).resolves.toBe(true);
    });

    it('preempts only after the persistence gate authorizes the close commit', async () => {
        const controller = createWorkspaceDocumentController({tabId: 'tab-1'});
        const openGate = Promise.withResolvers<undefined>();
        const persistenceGate = Promise.withResolvers<undefined>();
        const events: string[] = [];
        controller.attachWorkspace(cast<IWorkspaceExpose>({handleCloseFileFromUi: async (options?: ICloseFileFromUiOptions) => {
            events.push('persistence-start');
            expect(options?.persist).toBe(true);
            expect(controller.snapshot.value.phase).toBe('opening');
            await persistenceGate.promise;
            events.push('persistence-complete');
            expect(controller.snapshot.value.phase).toBe('opening');
            options?.onCloseCommit?.();
            events.push('close-commit');
            expect(controller.snapshot.value.phase).toBe('closing');
            return true;
        }}));

        const open = controller.open({
            action: 'open-recent',
            target: null,
        }, async () => {
            events.push('open-start');
            await openGate.promise;
            events.push('open-end');
            return true;
        });
        const close = controller.close({persist: true});

        expect(events).toEqual([
            'open-start',
            'persistence-start',
        ]);
        expect(controller.snapshot.value.phase).toBe('opening');

        persistenceGate.resolve(undefined);
        await expect(close).resolves.toBe(true);
        await expect(open).resolves.toBe(false);
        expect(events).toEqual([
            'open-start',
            'persistence-start',
            'persistence-complete',
            'close-commit',
        ]);
        expect(controller.snapshot.value.phase).toBe('empty');

        openGate.resolve(undefined);
        await Promise.resolve();
        expect(events.at(-1)).toBe('open-end');
        expect(controller.snapshot.value.phase).toBe('empty');
    });
});
