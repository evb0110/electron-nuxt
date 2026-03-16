import { registerOcrHandlers } from '@electron/features/ocr/main/ipc';
import type {
    IIpcMainRegistrar,
    IOcrService,
} from '@electron/features/ocr/ports';

export function createOcrService(): IOcrService {
    return {registerHandlers: (registrar: IIpcMainRegistrar) => {
        registerOcrHandlers(registrar);
    }};
}
