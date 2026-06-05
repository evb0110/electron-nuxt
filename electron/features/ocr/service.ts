import { registerOcrHandlers } from '@electron/features/ocr/main/ipc';
import type { IOcrService } from '@electron/features/ocr/ports';

export function createOcrService(): IOcrService {
    return {registerHandlers: (registrar) => {
        registerOcrHandlers(registrar);
    }};
}
