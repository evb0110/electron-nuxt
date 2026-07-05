import type { Ref } from 'vue';
import { BrowserLogger } from '@app/utils/browserLogger';
import { getErrorMessage } from '@app/utils/error';
import type { TTranslateFn } from '@i18n-app';

export type TSettingsAssistantAction = 'refresh' | 'install' | 'login' | 'cancel';

export interface ISettingsAssistantActionToast {add: (options: {
    color: 'error';
    title: string;
    description: string;
}) => void;}

export async function runSettingsAssistantAction(
    options: {
        action: TSettingsAssistantAction;
        activeAction: Ref<TSettingsAssistantAction | null>;
        isDesktopRuntime: boolean;
        run: () => Promise<void>;
        t: TTranslateFn;
        toast: ISettingsAssistantActionToast;
    },
) {
    if (!options.isDesktopRuntime || options.activeAction.value !== null) {
        return false;
    }

    options.activeAction.value = options.action;
    try {
        await options.run();
        return true;
    } catch (error) {
        BrowserLogger.warn('settings', 'Assistant settings action failed', {
            action: options.action,
            error,
        });
        options.toast.add({
            color: 'error',
            title: options.t('settings.assistantPanel'),
            description: getErrorMessage(error),
        });
        return false;
    } finally {
        options.activeAction.value = null;
    }
}
