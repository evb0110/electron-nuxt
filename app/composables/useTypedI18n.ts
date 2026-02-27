import type {
    TLocale,
    TTranslateFn,
} from '@i18n-core/locales';

interface ILocaleComposerMethods {
    setLocale: (locale: TLocale) => Promise<void>;
    loadLocaleMessages: (locale: TLocale) => Promise<void>;
}

interface ITypedI18nComposer extends ILocaleComposerMethods {t: TTranslateFn;}

export function useTypedI18n(): ITypedI18nComposer {
    const composer = useI18n();
    const localeComposer = composer as Partial<ILocaleComposerMethods>;
    const setLocale = async (locale: TLocale) => {
        await localeComposer.setLocale?.(locale);
    };
    const loadLocaleMessages = async (locale: TLocale) => {
        await localeComposer.loadLocaleMessages?.(locale);
    };
    return {
        ...composer,
        t: composer.t as TTranslateFn,
        setLocale,
        loadLocaleMessages,
    };
}
