import type { Page } from 'puppeteer-core';

type TSerializableValue =
    | boolean
    | number
    | string
    | null
    | TSerializableValue[]
    | { [key: string]: TSerializableValue | undefined }
    | undefined;

type TPageFunction<TResult, TArgs extends TSerializableValue[]> = (...args: TArgs) => TResult;

function serializeForPage(value: TSerializableValue): string {
    if (value === undefined) {
        return 'undefined';
    }
    if (typeof value === 'number') {
        if (Number.isNaN(value)) {
            return 'Number.NaN';
        }
        if (value === Number.POSITIVE_INFINITY) {
            return 'Number.POSITIVE_INFINITY';
        }
        if (value === Number.NEGATIVE_INFINITY) {
            return 'Number.NEGATIVE_INFINITY';
        }
        if (Object.is(value, -0)) {
            return '-0';
        }
    }

    return JSON.stringify(value);
}

function buildPageInvocation<TResult, TArgs extends TSerializableValue[]>(
    pageFunction: TPageFunction<TResult, TArgs>,
    args: TArgs,
) {
    const serializedArgs = args.map(serializeForPage).join(', ');
    return `(() => {
        const __name = (fn) => fn;
        return (${pageFunction.toString()})(${serializedArgs});
    })()`;
}

export async function evaluateInPage<TResult, TArgs extends TSerializableValue[]>(
    page: Page,
    pageFunction: TPageFunction<TResult, TArgs>,
    ...args: TArgs
): Promise<Awaited<TResult>> {
    return page.evaluate(buildPageInvocation(pageFunction, args)) as Promise<Awaited<TResult>>;
}

export async function waitForFunctionInPage<TResult, TArgs extends TSerializableValue[]>(
    page: Page,
    pageFunction: TPageFunction<TResult, TArgs>,
    options?: Parameters<Page['waitForFunction']>[1],
    ...args: TArgs
) {
    return page.waitForFunction(
        buildPageInvocation(pageFunction, args),
        options,
    );
}
