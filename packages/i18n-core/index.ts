export {
    DEFAULT_LOCALE,
    LOCALE_CODES,
    type TLocale,
} from './locale-codes';

export { LOCALE_DEFINITIONS } from './locale-definitions';

export {
    formatTranslationLeaf,
    getNestedTranslationLeaf,
    isPluralMessage,
    normalizeTranslationParams,
    plural,
    type IPluralMessage,
    type TMessageInterpolationValue,
    type TMessageParams,
    type TPluralCategory,
    type TPluralForms,
    type TTranslationLeaf,
} from './message-format';

export type {
    TLocaleMessagesShapeFrom,
    TLocaleSchemaFrom,
    TTranslationLeafFromSchema,
    TTranslationKeyFromNode,
    TTranslationMessageFromSchema,
    TTranslationParamsFromSchema,
} from './schema-types';

export type {
    ILocaleComposerMethods,
    TTypedI18nComposer,
} from './typed-composer';

export { createTypedI18nComposer } from './typed-composer';
