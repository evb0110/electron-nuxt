export {
    DEFAULT_LOCALE,
    LOCALE_CODES,
    type TLocale,
} from './localeCodes';

export { LOCALE_DEFINITIONS } from './localeDefinitions';

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
    type IPluralForms,
    type TTranslationLeaf,
} from './messageFormat';

export type {
    TLocaleMessagesShapeFrom,
    TLocaleSchemaFrom,
    TTranslationLeafFromSchema,
    TTranslationKeyFromNode,
    TTranslationMessageFromSchema,
    TTranslationParamsFromSchema,
} from './schemaTypes';

export type {
    ILocaleComposerMethods,
    TTypedI18nComposer,
} from './typedComposer';

export { createTypedI18nComposer } from './typedComposer';
