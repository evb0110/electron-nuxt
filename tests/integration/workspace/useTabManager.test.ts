import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { useTabManager } from '@app/composables/useTabManager';

const uuidSpy = vi.spyOn(crypto, 'randomUUID');
const UUID_A = '00000000-0000-0000-0000-00000000000a';
const UUID_B = '00000000-0000-0000-0000-00000000000b';
const UUID_C = '00000000-0000-0000-0000-00000000000c';
const UUID_Z = '00000000-0000-0000-0000-00000000000f';

describe('useTabManager', () => {
    beforeEach(() => {
        uuidSpy.mockReset();
        uuidSpy
            .mockReturnValueOnce(UUID_A)
            .mockReturnValueOnce(UUID_B)
            .mockReturnValueOnce(UUID_C)
            .mockReturnValue(UUID_Z);

        const manager = useTabManager();
        manager.tabs.value = [];
        manager.activeTabId.value = null;
    });

    it('creates at least one tab when empty', () => {
        const manager = useTabManager();

        manager.ensureAtLeastOneTab();

        expect(manager.tabs.value).toHaveLength(1);
        expect(manager.activeTabId.value).toBe(UUID_A);
        expect(manager.activeTab.value?.id).toBe(UUID_A);
    });

    it('closes active tab and activates the next available tab', () => {
        const manager = useTabManager();
        manager.createTab(); // UUID_A
        manager.createTab(); // UUID_B
        manager.createTab(); // UUID_C

        manager.activateTab(UUID_B);
        manager.closeTab(UUID_B);

        expect(manager.tabs.value.map(tab => tab.id)).toEqual([
            UUID_A,
            UUID_C,
        ]);
        expect(manager.activeTabId.value).toBe(UUID_C);
    });

    it('keeps one empty tab after closing the last tab', () => {
        const manager = useTabManager();
        const created = manager.createTab();

        manager.closeTab(created.id);

        expect(manager.tabs.value).toHaveLength(1);
        expect(manager.activeTabId.value).toBe(UUID_B);
    });

    it('moves tabs only for valid indices', () => {
        const manager = useTabManager();
        manager.createTab(); // UUID_A
        manager.createTab(); // UUID_B
        manager.createTab(); // UUID_C

        manager.moveTab(0, 2);
        expect(manager.tabs.value.map(tab => tab.id)).toEqual([
            UUID_B,
            UUID_C,
            UUID_A,
        ]);

        manager.moveTab(-1, 1);
        manager.moveTab(1, 99);
        expect(manager.tabs.value.map(tab => tab.id)).toEqual([
            UUID_B,
            UUID_C,
            UUID_A,
        ]);
    });

    it('updates and fetches tabs by id', () => {
        const manager = useTabManager();
        const tab = manager.createTab();

        manager.updateTab(tab.id, {
            fileName: 'updated.pdf',
            originalPath: '/tmp/updated.pdf',
            isDirty: true,
        });

        expect(manager.getTabById(tab.id)).toMatchObject({
            fileName: 'updated.pdf',
            originalPath: '/tmp/updated.pdf',
            isDirty: true,
        });
    });
});
