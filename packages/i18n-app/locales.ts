import de from './messages/de';
import en from './messages/en';
import es from './messages/es';
import fr from './messages/fr';
import it from './messages/it';
import nl from './messages/nl';
import pt from './messages/pt';
import ru from './messages/ru';
import {
    DEFAULT_LOCALE,
    type TLocaleSchemaFrom,
    type TLocale,
    type TTranslationMessageFromSchema,
    type TTranslationKeyFromNode,
    type TTranslationParamsFromSchema,
} from '@i18n-core';

export {
    DEFAULT_LOCALE,
    type TLocale,
};

type TBaseLocaleSchema = typeof en;
export type TLocaleSchema = TLocaleSchemaFrom<TBaseLocaleSchema>;
export const EN_MESSAGE_SCHEMA = en;

export const LOCALE_MESSAGES = {
    en,
    ru,
    fr,
    de,
    es,
    it,
    pt,
    nl,
} as const satisfies Record<TLocale, TLocaleSchema>;

export type TTranslationKey = TTranslationKeyFromNode<TBaseLocaleSchema>;

export type TTranslationParams<TKey extends TTranslationKey> = TTranslationParamsFromSchema<TBaseLocaleSchema, TKey>;
type TTranslationMessage<TKey extends TTranslationKey> = TTranslationMessageFromSchema<TBaseLocaleSchema, TKey>;
type THasPluralForms<TKey extends TTranslationKey> = TTranslationMessage<TKey> extends `${string}|${string}` ? true : false;
type TAllowsCountShortcut<TKey extends TTranslationKey> = TTranslationParams<TKey> extends {count: number;}
    ? true
    : THasPluralForms<TKey>;

export type TTranslateArgs<TKey extends TTranslationKey> = TTranslationParams<TKey> extends undefined
    ? TAllowsCountShortcut<TKey> extends true
        ? [params?: number]
        : [params?: undefined]
    : TAllowsCountShortcut<TKey> extends true
        ? [params: TTranslationParams<TKey> | number]
        : [params: TTranslationParams<TKey>];

export type TTranslateFn = <TKey extends TTranslationKey>(
    key: TKey,
    ...args: TTranslateArgs<TKey>
) => string;
