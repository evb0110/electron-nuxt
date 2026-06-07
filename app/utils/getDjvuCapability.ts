import type { IDjvuCapability } from '@contracts/electronApiDjvu';
import { getPlatformAPI } from '@app/utils/platform';

export function getDjvuCapability(): IDjvuCapability {
    return getPlatformAPI().djvu;
}
