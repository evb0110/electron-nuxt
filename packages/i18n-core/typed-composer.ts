export interface ILocaleComposerMethods<TLocale extends string> {
    setLocale: (locale: TLocale) => Promise<void>;
    loadLocaleMessages: (locale: TLocale) => Promise<void>;
}

export type TTypedI18nComposer<
    TComposer,
    TTranslateFn,
    TLocale extends string,
> = TComposer & ILocaleComposerMethods<TLocale> & {t: TTranslateFn;};

export function createTypedI18nComposer<
    TComposer extends {t: unknown;},
    TTranslateFn,
    TLocale extends string,
>(composer: TComposer): TTypedI18nComposer<TComposer, TTranslateFn, TLocale> {
    const localeComposer = composer as Partial<ILocaleComposerMethods<TLocale>>;
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
