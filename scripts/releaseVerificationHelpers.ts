interface IPackagedStartupReadiness {
    appAlive: boolean;
    rendererReady: boolean;
}

export function isPackagedStartupReady(state: IPackagedStartupReadiness) {
    return state.rendererReady && state.appAlive;
}

export function parseAllowedToolExitCodes(allowedCodes: string) {
    return new Set(
        allowedCodes
            .split(',')
            .map(code => Number.parseInt(code.trim(), 10))
            .filter(code => Number.isFinite(code)),
    );
}

export function isAllowedPackagedToolExitCode(
    exitCode: number,
    allowedCodes: string,
) {
    return parseAllowedToolExitCodes(allowedCodes).has(exitCode);
}
