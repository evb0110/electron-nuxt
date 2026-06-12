import type { InjectionKey } from 'vue';
import type { IPdfOutlineTreeContext } from '@app/modules/pdf-viewer/engine/pdf-outline-tree-context/pdfOutlineTreeContext';

export const pdfOutlineTreeKey: InjectionKey<IPdfOutlineTreeContext> = Symbol('PdfOutlineTree');
