const PLURAL_MESSAGE_KIND = 'plural';

export type TPluralCategory = Intl.LDMLPluralRule;
export type TMessageInterpolationValue = string | number;
export type TMessageParams = Record<string, TMessageInterpolationValue>;

export type TPluralForms<TText extends string = string> = {
    other: TText;
    zero?: TText;
    one?: TText;
    two?: TText;
    few?: TText;
    many?: TText;
};

export interface IPluralMessage<TForms extends TPluralForms<string> = TPluralForms<string>> {
    kind: typeof PLURAL_MESSAGE_KIND;
    forms: TForms;
}

export type TTranslationLeaf = string | IPluralMessage;

export function plural<const TForms extends TPluralForms<string>>(forms: TForms): IPluralMessage<TForms> {
    return {
        kind: PLURAL_MESSAGE_KIND,
        forms,
    };
}

export function isPluralMessage(value: unknown): value is IPluralMessage {
    return typeof value === 'object'
        && value !== null
        && 'kind' in value
        && (value as {kind?: unknown;}).kind === PLURAL_MESSAGE_KIND
        && 'forms' in value
        && typeof (value as {forms?: unknown;}).forms === 'object'
        && (value as {forms?: unknown;}).forms !== null;
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

function getFirstDefinedForm(forms: TPluralForms<string>): string {
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

    return forms.at(-1) ?? template;
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
