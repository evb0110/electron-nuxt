export type TLocaleFile<TLocale extends string> = `${TLocale}.ts`;

export interface ILocaleDefinition<TLocale extends string = string> {
    code: TLocale;
    file: TLocaleFile<TLocale>;
    name: string;
}
