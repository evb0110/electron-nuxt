import type { ISearchCapability } from '@contracts/platformApi';
import { getPlatformAPI } from '@app/utils/platform';

export function getSearchCapability(): ISearchCapability {
    return getPlatformAPI().search;
}
