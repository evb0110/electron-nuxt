type TProcessEnv = Record<string, string | undefined>;

interface IRuntimeGlobal {process?: {env?: TProcessEnv;};}

export function getRuntimeEnv(): TProcessEnv {
    return (globalThis as typeof globalThis & IRuntimeGlobal).process?.env ?? {};
}
