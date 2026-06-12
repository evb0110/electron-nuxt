import { STORAGE_KEYS } from '@app/constants/storageKeys';
import { safeGetLocalStorageItem } from '@app/utils/localStorage';

export function isOcrDebugEnabled() {
    return safeGetLocalStorageItem(STORAGE_KEYS.OCR_DEBUG_BOXES) === '1';
}
