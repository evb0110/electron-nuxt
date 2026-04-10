import type { IDjvuCapability } from '@contracts/platform-api';
import { getPlatformAPI } from '@app/utils/platform';

export function getDjvuCapability(): IDjvuCapability {
    return getPlatformAPI().djvu;
}
