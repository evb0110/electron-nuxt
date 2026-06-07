import type { IOcrCapability } from '@contracts/electronApiOcr';
import { getPlatformAPI } from '@app/utils/platform';

export function getOcrCapability(): IOcrCapability {
    return getPlatformAPI().ocr;
}
