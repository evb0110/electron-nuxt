import { useTypedI18n } from '@app/composables/useTypedI18n';

const { t } = useTypedI18n();

t('export.scopeAll', { count: 2 });
t('searchResults.resultCount', 3);
t('toolbar.openPdf');

// @ts-expect-error placeholder params are required for pluralized renderer messages
t('export.scopeAll');

// @ts-expect-error params are not allowed for plain renderer messages
t('toolbar.openPdf', { count: 1 });

// @ts-expect-error count shorthand is only valid for messages that accept count
t('toolbar.openPdf', 1);
