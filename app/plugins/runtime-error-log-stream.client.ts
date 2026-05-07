import type { IDebugLogEntry } from '@contracts/platform-api';
import { getSettingsCapability } from '@app/utils/platform-settings';

function isUiReportableLog(entry: IDebugLogEntry) {
    return entry.message.startsWith('[WARN]') || entry.message.startsWith('[ERROR]');
}

export default defineNuxtPlugin((nuxtApp) => {
    if (!import.meta.client) {
        return;
    }

    const { reportRuntimeError } = useRuntimeErrorReports();
    const { t } = useTypedI18n();

    nuxtApp.hook('app:mounted', () => {
        getSettingsCapability().onDebugLog((entry) => {
            if (!isUiReportableLog(entry)) {
                return;
            }

            reportRuntimeError({
                title: entry.message.startsWith('[ERROR]')
                    ? t('errors.runtime.streamError')
                    : t('errors.runtime.streamWarning'),
                source: entry.source,
                error: `${entry.timestamp}\n${entry.message}`,
            });
        });
    });
});
