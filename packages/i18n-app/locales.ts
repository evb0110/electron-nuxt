import de from './messages/de';
import en from './messages/en';
import es from './messages/es';
import fr from './messages/fr';
import it from './messages/it';
import nl from './messages/nl';
import pt from './messages/pt';
import ru from './messages/ru';
import type { EN_MESSAGE_SCHEMA } from './message-schema';
import {
    DEFAULT_LOCALE,
    type TLocaleSchemaFrom,
    type TLocale,
    type TTranslationKeyFromNode,
    type TTranslationParamsFromSchema,
} from '@i18n-core';

export {
    DEFAULT_LOCALE,
    type TLocale,
};

type TBaseLocaleSchema = typeof EN_MESSAGE_SCHEMA;
export type TLocaleSchema = TLocaleSchemaFrom<TBaseLocaleSchema>;

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

export type TTranslateFn = (
    key: TTranslationKey,
    params?: Record<string, string | number | undefined> | number,
) => string;
