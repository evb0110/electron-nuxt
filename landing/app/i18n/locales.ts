/* eslint-disable no-restricted-imports */
import en from '../locales/en';
import type { EN_MESSAGE_SCHEMA } from './messageSchema';
import {
    DEFAULT_LOCALE,
    LOCALE_CODES,
    LOCALE_DEFINITIONS,
    type TLocale,
    type TMessageParams,
    type TLocaleSchemaFrom,
    type TTranslationKeyFromNode,
    type TTranslationParamsFromSchema,
} from './core';

export {
    DEFAULT_LOCALE,
    LOCALE_CODES,
    LOCALE_DEFINITIONS,
    type TLocale,
};

type TBaseLocaleSchema = typeof EN_MESSAGE_SCHEMA;
export type TLocaleSchema = TLocaleSchemaFrom<TBaseLocaleSchema>;

export const LOCALE_MESSAGES = {
    en,
} as const satisfies Record<TLocale, TLocaleSchema>;

export type TTranslationKey = TTranslationKeyFromNode<TBaseLocaleSchema>;

export type TTranslationParams<TKey extends TTranslationKey> = TTranslationParamsFromSchema<TBaseLocaleSchema, TKey>;

export type TTranslateFn = (
    key: TTranslationKey,
    params?: TMessageParams | number,
) => string;
