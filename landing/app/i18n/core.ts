export const LOCALE_CODES = [
    'de',
    'en',
    'es',
    'fr',
    'it',
    'nl',
    'pt',
    'ru',
] as const;

export type TLocale = typeof LOCALE_CODES[number];

export const DEFAULT_LOCALE: TLocale = 'en';

interface ILocaleDefinition<TLocaleCode extends string = string> {
    code: TLocaleCode;
    file: `${TLocaleCode}.ts`;
    language: string;
    name: string;
}

export const LOCALE_DEFINITIONS = [
    {
        code: 'de',
        file: 'de.ts',
        language: 'de-DE',
        name: 'Deutsch',
    },
    {
        code: 'en',
        file: 'en.ts',
        language: 'en-US',
        name: 'English',
    },
    {
        code: 'es',
        file: 'es.ts',
        language: 'es-ES',
        name: 'Español',
    },
    {
        code: 'fr',
        file: 'fr.ts',
        language: 'fr-FR',
        name: 'Français',
    },
    {
        code: 'it',
        file: 'it.ts',
        language: 'it-IT',
        name: 'Italiano',
    },
    {
        code: 'nl',
        file: 'nl.ts',
        language: 'nl-NL',
        name: 'Nederlands',
    },
    {
        code: 'pt',
        file: 'pt.ts',
        language: 'pt-PT',
        name: 'Português',
    },
    {
        code: 'ru',
        file: 'ru.ts',
        language: 'ru-RU',
        name: 'Русский',
    },
] as const satisfies ReadonlyArray<ILocaleDefinition<TLocale>>;

export interface ILocaleComposerMethods<TLocaleCode extends string> {
    setLocale: (locale: TLocaleCode) => Promise<void>;
    loadLocaleMessages: (locale: TLocaleCode) => Promise<void>;
}

export type TTypedI18nComposer<
    TComposer,
    TTranslateFn,
    TLocaleCode extends string,
> = TComposer & ILocaleComposerMethods<TLocaleCode> & { t: TTranslateFn; };

export function createTypedI18nComposer<
    TComposer extends { t: TTranslateFn; } & Partial<ILocaleComposerMethods<TLocaleCode>>,
    TTranslateFn,
    TLocaleCode extends string,
>(composer: TComposer): TTypedI18nComposer<TComposer, TTranslateFn, TLocaleCode> {
    const setLocale = async (locale: TLocaleCode) => {
        await composer.setLocale?.(locale);
    };
    const loadLocaleMessages = async (locale: TLocaleCode) => {
        await composer.loadLocaleMessages?.(locale);
    };

    return Object.assign(composer, {
        setLocale,
        loadLocaleMessages,
    });
}

const PLURAL_MESSAGE_KIND = 'plural';

export type TPluralCategory = Intl.LDMLPluralRule;
export type TMessageInterpolationValue = string | number;
export type TMessageParams = Record<string, TMessageInterpolationValue>;

export interface IPluralForms<TText extends string = string> {
    other: TText;
    zero?: TText;
    one?: TText;
    two?: TText;
    few?: TText;
    many?: TText;
}

export interface IPluralMessage<TForms extends IPluralForms<string> = IPluralForms<string>> {
    kind: typeof PLURAL_MESSAGE_KIND;
    forms: TForms;
}

export type TTranslationLeaf = string | IPluralMessage;

export function isPluralMessage(value: unknown): value is IPluralMessage {
    return typeof value === 'object'
        && value !== null
        && 'kind' in value
        && (value as { kind?: unknown; }).kind === PLURAL_MESSAGE_KIND
        && 'forms' in value
        && typeof (value as { forms?: unknown; }).forms === 'object'
        && (value as { forms?: unknown; }).forms !== null;
}

export function normalizeTranslationParams(rawParams?: number | TMessageParams): TMessageParams | undefined {
    if (typeof rawParams === 'number') {
        return { count: rawParams };
    }

    return rawParams;
}

export function getNestedTranslationLeaf(messages: Record<string, unknown>, path: string): TTranslationLeaf | null {
    const parts = path.split('.');
    let current: unknown = messages;

    for (const part of parts) {
        if (!current || typeof current !== 'object' || !(part in current)) {
            return null;
        }

        current = (current as Record<string, unknown>)[part];
    }

    return typeof current === 'string' || isPluralMessage(current)
        ? current
        : null;
}

const pluralRulesCache = new Map<string, Intl.PluralRules>();

function getPluralRules(locale: string): Intl.PluralRules {
    const cached = pluralRulesCache.get(locale);
    if (cached) {
        return cached;
    }

    const rules = new Intl.PluralRules(locale);
    pluralRulesCache.set(locale, rules);
    return rules;
}

function getPluralCategory(locale: string, count: number): TPluralCategory {
    return getPluralRules(locale).select(count);
}

function getFirstDefinedForm(forms: IPluralForms<string>): string {
    return forms.zero
        ?? forms.one
        ?? forms.two
        ?? forms.few
        ?? forms.many
        ?? forms.other;
}

function selectPluralMessageForm(message: IPluralMessage, count: number | null, locale: string): string {
    if (count === null) {
        return message.forms.other ?? getFirstDefinedForm(message.forms);
    }

    if (count === 0 && message.forms.zero) {
        return message.forms.zero;
    }

    const category = getPluralCategory(locale, count);
    return message.forms[category]
        ?? message.forms.other
        ?? getFirstDefinedForm(message.forms);
}

function selectLegacyPipeForm(template: string, count: number, locale: string): string {
    const forms = template.split('|').map(part => part.trim());
    if (forms.length === 1) {
        return forms[0] ?? template;
    }

    const category = getPluralCategory(locale, count);
    if (forms.length === 2) {
        return category === 'one'
            ? (forms[0] ?? template)
            : (forms[1] ?? forms[0] ?? template);
    }

    if (forms.length === 3) {
        if (category === 'one') {
            return forms[0] ?? template;
        }

        if (category === 'few') {
            return forms[1] ?? forms[0] ?? template;
        }

        return forms[2] ?? forms[1] ?? forms[0] ?? template;
    }

    if (category === 'zero') {
        return forms[0] ?? template;
    }

    if (category === 'one') {
        return forms[1] ?? forms[0] ?? template;
    }

    if (category === 'two' || category === 'few') {
        return forms[2] ?? forms[1] ?? forms[0] ?? template;
    }

    return forms[forms.length - 1] ?? template;
}

export function formatTranslationLeaf(
    leaf: TTranslationLeaf | string,
    params?: TMessageParams,
    locale = 'en',
): string {
    const count = typeof params?.count === 'number'
        ? params.count
        : null;
    const template = isPluralMessage(leaf)
        ? selectPluralMessageForm(leaf, count, locale)
        : count === null
            ? leaf
            : selectLegacyPipeForm(leaf, count, locale);

    return template.replace(/\{(\w+)\}/g, (_match, key: string) => {
        const value = params?.[key];
        return value === undefined
            ? `{${key}}`
            : String(value);
    });
}

export type TLocaleSchemaFrom<TNode> = {
    [TKey in keyof TNode]: TNode[TKey] extends TTranslationLeaf
        ? string
        : TNode[TKey] extends object
            ? TLocaleSchemaFrom<TNode[TKey]>
            : never;
};

export type TTranslationKeyFromNode<TNode extends object> = {
    [TKey in keyof TNode & string]: TNode[TKey] extends TTranslationLeaf
        ? TKey
        : TNode[TKey] extends object
            ? `${TKey}.${TTranslationKeyFromNode<TNode[TKey]>}`
            : never;
}[keyof TNode & string];

type TValueAtPath<TNode, TPath extends string> = TNode extends object
    ? TPath extends `${infer THead}.${infer TTail}`
        ? THead extends keyof TNode
            ? TValueAtPath<TNode[THead], TTail>
            : never
        : TPath extends keyof TNode
            ? TNode[TPath]
            : never
    : never;

type TTrim<TText extends string> = TText extends ` ${infer TRest}`
    ? TTrim<TRest>
    : TText extends `${infer TRest} `
        ? TTrim<TRest>
        : TText;

type TNormalizePlaceholder<TPlaceholder extends string> = TPlaceholder extends `${infer TKey},${string}`
    ? TTrim<TKey>
    : TTrim<TPlaceholder>;

type TPlaceholderNames<TText extends string> = TText extends `${string}{${infer TPlaceholder}}${infer TRest}`
    ? TNormalizePlaceholder<TPlaceholder> | TPlaceholderNames<TRest>
    : never;

type TPlaceholderValue<TKey extends string> = TKey extends 'count'
    ? number
    : string | number;

type THasPluralForms<TText extends string> = TText extends `${string}|${string}`
    ? true
    : false;

type TTextFromLeaf<TLeaf> = TLeaf extends string
    ? TLeaf
    : TLeaf extends IPluralMessage<infer TForms>
        ? TForms[keyof TForms] & string
        : never;

type TMessageParamNames<TLeaf> = TLeaf extends IPluralMessage<infer TForms>
    ? TPlaceholderNames<TForms[keyof TForms] & string> | 'count'
    : TLeaf extends string
        ? THasPluralForms<TLeaf> extends true
            ? TPlaceholderNames<TLeaf> | 'count'
            : TPlaceholderNames<TLeaf>
        : never;

type TParamsFromMessage<TLeaf> = [TMessageParamNames<TLeaf>] extends [never]
    ? undefined
    : { [TKey in TMessageParamNames<TLeaf>]: TPlaceholderValue<TKey> };

type TTranslationLeafFromSchema<
    TSchema extends object,
    TKey extends TTranslationKeyFromNode<TSchema>,
> = TValueAtPath<TSchema, TKey> extends TTranslationLeaf
    ? TValueAtPath<TSchema, TKey>
    : never;

export type TTranslationParamsFromSchema<
    TSchema extends object,
    TKey extends TTranslationKeyFromNode<TSchema>,
> = TParamsFromMessage<TTranslationLeafFromSchema<TSchema, TKey>>;
