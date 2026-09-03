import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { ref } from 'vue';
import { runSettingsAssistantAction } from '@app/modules/workspace-shell/agent/runSettingsAssistantAction';
import type { TTranslateFn } from '@i18n-app';

describe('runSettingsAssistantAction', () => {
    it('returns one receipt to the feature presenter when an assistant action fails', async () => {
        const toast = {add: vi.fn()};
        const activeAction = ref<null | 'refresh' | 'install' | 'login' | 'cancel'>(null);
        const onFailure = vi.fn();

        const result = await runSettingsAssistantAction({
            action: 'refresh',
            activeAction,
            isDesktopRuntime: true,
            run: vi.fn(async () => {
                throw new Error('assistant exploded');
            }),
            t: ((key: string) => key) as TTranslateFn,
            toast,
            onFailure,
        });

        expect(result).toBe(false);
        expect(activeAction.value).toBeNull();
        expect(toast.add).not.toHaveBeenCalled();
        expect(onFailure).toHaveBeenCalledOnce();
        expect(onFailure.mock.calls[0]?.[0]).toMatchObject({
            failure: {code: 'ASSISTANT_ACTION_FAILED'},
            title: 'settings.assistantPanel',
        });
    });

    it('keeps an expected assistant refusal warning-only without a receipt', async () => {
        const toast = {add: vi.fn()};
        const activeAction = ref<null | 'refresh' | 'install' | 'login' | 'cancel'>(null);
        const onFailure = vi.fn();

        const result = await runSettingsAssistantAction({
            action: 'refresh',
            activeAction,
            isDesktopRuntime: true,
            run: vi.fn(async () => {
                throw {expected: {
                    kind: 'expected',
                    code: 'temporarily-unavailable',
                }};
            }),
            t: ((key: string) => key) as TTranslateFn,
            toast,
            onFailure,
        });

        expect(result).toBe(false);
        expect(onFailure).not.toHaveBeenCalled();
        expect(toast.add).toHaveBeenCalledWith(expect.objectContaining({color: 'warning'}));
    });

    it('suppresses stale toast and state writes after its owner is disposed', async () => {
        const action = Promise.withResolvers<never>();
        const toast = {add: vi.fn()};
        const activeAction = ref<null | 'refresh' | 'install' | 'login' | 'cancel'>(null);
        let active = true;
        const result = runSettingsAssistantAction({
            action: 'refresh',
            activeAction,
            isDesktopRuntime: true,
            isActive: () => active,
            run: () => action.promise,
            t: ((key: string) => key) as TTranslateFn,
            toast,
        });
        expect(activeAction.value).toBe('refresh');

        active = false;
        action.reject(new Error('late failure'));
        await expect(result).resolves.toBe(false);

        expect(toast.add).not.toHaveBeenCalled();
        expect(activeAction.value).toBe('refresh');
    });
});
