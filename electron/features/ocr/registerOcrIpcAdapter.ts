import {createOcrService} from '@electron/features/ocr/createOcrService';
import type {
    TOcrIpcMainRegistrar,
    IOcrService,
} from '@electron/features/ocr/ports';

export function registerOcrIpcAdapter(
    registrar: TOcrIpcMainRegistrar,
    service: IOcrService = createOcrService(),
) {
    service.registerHandlers(registrar);
}
