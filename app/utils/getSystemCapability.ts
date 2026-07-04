import type { ISystemCapability } from '@contracts/electronApiSystem';
import { getPlatformAPI } from '@app/utils/platform';

const fallbackSystemCapability: ISystemCapability = {
    getMemoryInfo: () => null,
    onShutdownSaveFlushRequest: () => () => {},
};

export function getSystemCapability(): ISystemCapability {
    const platform = getPlatformAPI() as { system?: ISystemCapability };
    return platform.system ?? fallbackSystemCapability;
}
