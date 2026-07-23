import type {
    IAppUpdateStatus,
    IUpdatesCapability,
} from '@contracts/updatesPlatformFeature';
import { getPlatformAPI } from '@app/utils/platform';

export function getUpdatesCapability(): IUpdatesCapability | undefined {
    return getPlatformAPI().updates;
}

export function isUpdatesCapabilitySupported(status: IAppUpdateStatus) {
    return status.phase !== 'unsupported';
}
