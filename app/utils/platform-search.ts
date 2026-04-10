import type { ISearchCapability } from '@contracts/platform-api';
import { getPlatformAPI } from '@app/utils/platform';

export function getSearchCapability(): ISearchCapability {
    return getPlatformAPI().search;
}
