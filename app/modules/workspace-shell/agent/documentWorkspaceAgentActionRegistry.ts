export type TAgentActionHandlerRunResult = object | Promise<object>;

interface IParsedAgentAction {run: () => TAgentActionHandlerRunResult;}

interface IAgentActionHandler {parse: (input: Record<string, unknown>, actionId: string) => IParsedAgentAction;}

export interface IAgentActionHandlerDefinition<TParsedInput> {
    ids: readonly string[];
    parse(input: Record<string, unknown>, actionId: string): TParsedInput;
    run(parsedInput: TParsedInput, actionId: string): TAgentActionHandlerRunResult;
}

function createAgentActionHandler<TParsedInput>(
    definition: IAgentActionHandlerDefinition<TParsedInput>,
): IAgentActionHandler {
    return {parse: (input, actionId) => {
        const parsedInput = definition.parse(input, actionId);
        return {run: () => definition.run(parsedInput, actionId)};
    }};
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
    return definition;
}
