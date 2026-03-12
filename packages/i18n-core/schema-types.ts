export type TLocaleSchemaFrom<TNode> = {
    [TKey in keyof TNode]: TNode[TKey] extends string
        ? string
        : TNode[TKey] extends object
            ? TLocaleSchemaFrom<TNode[TKey]>
            : never;
};

export type TTranslationKeyFromNode<TNode extends object> = {
    [TKey in keyof TNode & string]: TNode[TKey] extends string
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

type TMessageParamNames<TText extends string> = THasPluralForms<TText> extends true
    ? TPlaceholderNames<TText> | 'count'
    : TPlaceholderNames<TText>;

type TParamsFromMessage<TText extends string> = [TMessageParamNames<TText>] extends [never]
    ? undefined
    : { [TKey in TMessageParamNames<TText>]: TPlaceholderValue<TKey> };

export type TTranslationMessageFromSchema<
    TSchema extends object,
    TKey extends TTranslationKeyFromNode<TSchema>,
> = TValueAtPath<TSchema, TKey> extends string
    ? TValueAtPath<TSchema, TKey>
    : never;

export type TTranslationParamsFromSchema<
    TSchema extends object,
    TKey extends TTranslationKeyFromNode<TSchema>,
> = TParamsFromMessage<TTranslationMessageFromSchema<TSchema, TKey>>;
