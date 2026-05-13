import type { IOcrCapability } from '@contracts/platformApi';
import { getPlatformAPI } from '@app/utils/platform';

export function getOcrCapability(): IOcrCapability {
    return getPlatformAPI().ocr;
}
