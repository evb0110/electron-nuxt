import {
    describe,
    expect,
    it,
} from 'vitest';
import { createWorkspaceDocumentController } from '@app/modules/workspace-shell/document-sessions/workspaceDocumentController';
import type { IWorkspaceExpose } from '@app/types/workspaceExpose';
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

    it('serializes close behind an active open on the same controller queue', async () => {
        const controller = createWorkspaceDocumentController({tabId: 'tab-1'});
        const openGate = Promise.withResolvers<undefined>();
        const events: string[] = [];
        controller.attachWorkspace(cast<IWorkspaceExpose>({handleCloseFileFromUi: async () => {
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

        expect(events).toEqual(['open-start']);
        openGate.resolve(undefined);
        await Promise.all([
            open,
            close,
        ]);
        expect(events).toEqual([
            'open-start',
            'open-end',
            'close',
        ]);
    });
});
