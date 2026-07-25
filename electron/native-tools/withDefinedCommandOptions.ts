import type { IRunCommandOptions } from '@electron/native-tools/runNativeCommand';

export function withDefinedCommandOptions(
    base: IRunCommandOptions,
    overrides: Partial<IRunCommandOptions>,
): IRunCommandOptions {
    const merged: IRunCommandOptions = {...base};
    for (const [
        key,
        value,
    ] of Object.entries(overrides)) {
        if (value !== undefined) {
            Object.assign(merged, {[key]: value});
        }
    }
    return merged;
}
