interface ICommandLineLike {
    appendSwitch(name: string, value?: string): void;
    hasSwitch?: (name: string) => boolean;
}

interface IAppLike {commandLine: ICommandLineLike;}

export const MAC_SAFE_STORAGE_KEYCHAIN_SWITCH = 'use-mock-keychain';
export const MAC_SYSTEM_KEYCHAIN_ENV = 'EVB_USE_SYSTEM_KEYCHAIN';

export function configureMacKeychainAccess(
    app: IAppLike,
    options: {
        env?: NodeJS.ProcessEnv;
        platform?: NodeJS.Platform;
    } = {},
) {
    const platform = options.platform ?? process.platform;
    if (platform !== 'darwin') {
        return false;
    }

    const env = options.env ?? process.env;
    if (env[MAC_SYSTEM_KEYCHAIN_ENV] === '1') {
        return false;
    }

    if (app.commandLine.hasSwitch?.(MAC_SAFE_STORAGE_KEYCHAIN_SWITCH) === true) {
        return false;
    }

    app.commandLine.appendSwitch(MAC_SAFE_STORAGE_KEYCHAIN_SWITCH);
    return true;
}
