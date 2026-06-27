export type TAgentActionHandlerRunResult = object | Promise<object>;

export interface IAgentActionHandler {
    parse: (input: Record<string, unknown>, actionId: string) => unknown;
    run: (parsedInput: unknown, actionId: string) => TAgentActionHandlerRunResult;
}

export interface IAgentActionHandlerDefinition<TParsedInput> {
    ids: readonly string[];
    parse(input: Record<string, unknown>, actionId: string): TParsedInput;
    run(parsedInput: TParsedInput, actionId: string): TAgentActionHandlerRunResult;
}

function createAgentActionHandler<TParsedInput>(
    definition: IAgentActionHandlerDefinition<TParsedInput>,
): IAgentActionHandler {
    return {
        parse: definition.parse,
        run: (parsedInput, actionId) => definition.run(parsedInput as TParsedInput, actionId),
    };
}

export function createAgentActionHandlerRegistry(
    definitions: ReadonlyArray<IAgentActionHandlerDefinition<unknown>>,
) {
    return Object.fromEntries(
        definitions.flatMap(definition => definition.ids.map(id => [
            id,
            createAgentActionHandler(definition),
        ])),
    ) as Record<string, IAgentActionHandler>;
}

export function defineAgentActionHandler<TParsedInput>(
    definition: IAgentActionHandlerDefinition<TParsedInput>,
) {
    return definition as IAgentActionHandlerDefinition<unknown>;
}
