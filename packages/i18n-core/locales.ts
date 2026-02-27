import de from '@app/locales/de';
import en from '@app/locales/en';
import es from '@app/locales/es';
import fr from '@app/locales/fr';
import it from '@app/locales/it';
import nl from '@app/locales/nl';
import pt from '@app/locales/pt';
import ru from '@app/locales/ru';
import type { EN_MESSAGE_SCHEMA } from '@app/i18n/message-schema';
import {
    DEFAULT_LOCALE,
    type TLocale,
} from './locale-codes';
import type {
    TLocaleSchemaFrom,
    TTranslationKeyFromNode,
    TTranslationParamsFromSchema,
} from './schema-types';

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
