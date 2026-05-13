import type {
    IAppUpdateStatus,
    IUpdatesCapability,
} from '@contracts/platformApi';
import { getPlatformAPI } from '@app/utils/platform';

export function getUpdatesCapability(): IUpdatesCapability {
    return getPlatformAPI().updates;
}

export function isUpdatesCapabilitySupported(status: IAppUpdateStatus) {
    return status.phase !== 'unsupported';
}
