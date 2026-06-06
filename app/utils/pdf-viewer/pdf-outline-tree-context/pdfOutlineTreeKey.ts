import type { InjectionKey } from 'vue';
import type { IPdfOutlineTreeContext } from '@app/utils/pdf-viewer/pdf-outline-tree-context/pdfOutlineTreeContext';

export const pdfOutlineTreeKey: InjectionKey<IPdfOutlineTreeContext> = Symbol('PdfOutlineTree');
