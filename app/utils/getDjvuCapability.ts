import type { IDjvuCapability } from '@contracts/platformApi';
import { getPlatformAPI } from '@app/utils/platform';

export function getDjvuCapability(): IDjvuCapability {
    return getPlatformAPI().djvu;
}
