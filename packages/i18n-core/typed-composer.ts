export interface ILocaleComposerMethods<TLocale extends string> {
    setLocale: (locale: TLocale) => Promise<void>;
    loadLocaleMessages: (locale: TLocale) => Promise<void>;
}

export type TTypedI18nComposer<
    TComposer,
    TTranslateFn,
    TLocale extends string,
> = TComposer & ILocaleComposerMethods<TLocale> & {t: TTranslateFn;};

type TTypedI18nComposerInput<
    TComposer,
    TTranslateFn,
    TLocale extends string,
> = TComposer & {t: TTranslateFn;} & Partial<ILocaleComposerMethods<TLocale>>;

export function createTypedI18nComposer<
    TTranslateFn,
    TLocale extends string,
    TComposer extends object = object,
>(composer: TTypedI18nComposerInput<TComposer, TTranslateFn, TLocale>): TTypedI18nComposer<TComposer, TTranslateFn, TLocale> {
    const setLocale = async (locale: TLocale) => {
        await composer.setLocale?.(locale);
    };
    const loadLocaleMessages = async (locale: TLocale) => {
        await composer.loadLocaleMessages?.(locale);
    };

    return {
        ...composer,
        setLocale,
        loadLocaleMessages,
    };
}
