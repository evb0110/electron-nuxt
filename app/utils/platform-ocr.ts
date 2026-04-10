import type { IOcrCapability } from '@contracts/platform-api';
import { getPlatformAPI } from '@app/utils/platform';

export function getOcrCapability(): IOcrCapability {
    return getPlatformAPI().ocr;
}
