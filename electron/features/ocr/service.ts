import { registerOcrHandlers } from '@electron/features/ocr/main/ipc';
import type {
    TOcrIpcMainRegistrar,
    IOcrService,
} from '@electron/features/ocr/ports';

export function createOcrService(): IOcrService {
    return {registerHandlers: (registrar: TOcrIpcMainRegistrar) => {
        registerOcrHandlers(registrar);
    }};
}
