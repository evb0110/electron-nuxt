import type {
    TLocale,
    TTranslateFn,
} from '@i18n-app';
import { createTypedI18nComposer } from '@i18n-core';

interface IAppTypedI18nComposer {
    t: TTranslateFn;
    setLocale: (locale: TLocale) => Promise<void>;
    loadLocaleMessages: (locale: TLocale) => Promise<void>;
}

export function useTypedI18n(): IAppTypedI18nComposer {
    const composer = useI18n();
    return createTypedI18nComposer<TTranslateFn, TLocale>(composer);
}
