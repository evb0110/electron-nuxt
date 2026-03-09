import {
    describe,
    expect,
    it,
} from 'vitest';
import { ref } from 'vue';
import { useDirtyTabCloseDialog } from '@app/modules/workspace-shell/composables/useDirtyTabCloseDialog';

describe('useDirtyTabCloseDialog', () => {
    it('resolves confirmation with true when confirmed', async () => {
        const tabs = ref([{
            id: 'tab-1',
            fileName: 'a.pdf',
            originalPath: '/docs/a.pdf',
            isDirty: true,
            isDjvu: false,
        }]);
        const dialog = useDirtyTabCloseDialog({tabs});

        const confirmationPromise = dialog.requestDirtyTabCloseConfirmation('tab-1');
        expect(dialog.dirtyTabCloseDialogOpen.value).toBe(true);
        expect(dialog.dirtyTabCloseTargetName.value).toBe('a.pdf');

        dialog.confirmDirtyTabClose();
        await expect(confirmationPromise).resolves.toBe(true);
        expect(dialog.dirtyTabCloseDialogOpen.value).toBe(false);
    });

    it('falls back to new-tab label and resolves false on external close', async () => {
        const tabs = ref([]);
        const dialog = useDirtyTabCloseDialog({tabs});

        const confirmationPromise = dialog.requestDirtyTabCloseConfirmation('missing-tab');
        expect(dialog.dirtyTabCloseTargetName.value).toBe('tabs.newTab');

        dialog.resolveDirtyTabCloseDialog(false);
        await expect(confirmationPromise).resolves.toBe(false);
    });
});
