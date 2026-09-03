import type { Ref } from 'vue';
import { BrowserLogger } from '@app/utils/browserLogger';
import { getErrorMessage } from '@app/utils/error';
import {
    captureAssistantFailure,
    getAssistantExpectedOutcome,
} from '@app/modules/agent-panel/public/assistantFailure';
import type { FailurePresentation } from '@app/composables/useFailureToast';
import type { TTranslateFn } from '@i18n-app';

export type TSettingsAssistantAction = 'refresh' | 'install' | 'login' | 'cancel';

export interface ISettingsAssistantActionToast {add: (options: {
    color: 'warning' | 'neutral';
    title: string;
    description: string;
}) => void;}

export async function runSettingsAssistantAction(
    options: {
        action: TSettingsAssistantAction;
        activeAction: Ref<TSettingsAssistantAction | null>;
        isDesktopRuntime: boolean;
        run: () => Promise<void>;
        isActive?: () => boolean;
        t: TTranslateFn;
        toast: ISettingsAssistantActionToast;
        onFailure?: (presentation: FailurePresentation) => void;
    },
) {
    if (
        !options.isDesktopRuntime
        || options.activeAction.value !== null
        || options.isActive?.() === false
    ) {
        return false;
    }

    options.activeAction.value = options.action;
    try {
        await options.run();
        return true;
    } catch (error) {
        const expected = getAssistantExpectedOutcome(
            error,
            options.action === 'cancel' ? 'canceled' : undefined,
        );
        if (expected) {
            BrowserLogger.warn('settings', 'Assistant settings action was not completed', {
                action: options.action,
                expected,
                error,
            });
            if (options.isActive?.() !== false) {
                options.toast.add({
                    color: 'warning',
                    title: options.t('settings.assistantPanel'),
                    description: getErrorMessage(error),
                });
            }
            return false;
        }

        const presentation = captureAssistantFailure(error, {
            action: options.action,
            section: 'settings',
            logMessage: 'Assistant settings action failed',
            title: options.t('settings.assistantPanel'),
        });
        if (options.isActive?.() !== false) {
            options.onFailure?.(presentation);
        }
        return false;
    } finally {
        if (options.isActive?.() !== false) {
            options.activeAction.value = null;
        }
    }
}
