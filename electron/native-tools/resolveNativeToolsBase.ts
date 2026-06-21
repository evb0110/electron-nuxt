import { join } from 'path';
import { resolveOcrResourcesBase } from '@electron/ocr/resolveOcrResourcesBase';

interface IResolveNativeToolsBaseOptions {
    platform?: NodeJS.Platform;
    resourcesBase?: string;
}

export function resolveNativeToolsBase(
    moduleDir: string,
    isPackaged: boolean,
    options: IResolveNativeToolsBaseOptions = {},
) {
    const resourcesBase = options.resourcesBase ?? resolveOcrResourcesBase(moduleDir, isPackaged);
    const platform = options.platform ?? process.platform;

    if (isPackaged && platform === 'darwin') {
        return join(resourcesBase, '..', 'MacOS', 'native-tools');
    }

    return resourcesBase;
}
