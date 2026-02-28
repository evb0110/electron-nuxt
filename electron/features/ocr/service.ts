import { registerOcrHandlers } from '@electron/ocr/ipc';
import type {
    IIpcMainRegistrar,
    IOcrService,
} from '@electron/features/ocr/ports';

export function createOcrService(): IOcrService {
    return {registerHandlers: (registrar: IIpcMainRegistrar) => {
        registerOcrHandlers(registrar);
    }};
}
