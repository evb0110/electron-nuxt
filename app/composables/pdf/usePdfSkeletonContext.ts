import { pdfSkeletonContextKey } from '@app/utils/pdf-viewer/pdfSkeletonContextKey';

export const usePdfSkeletonContext = () => {
    const context = inject(pdfSkeletonContextKey);
    if (!context) {
        throw new Error('usePdfSkeletonContext must be used within a component that calls usePdfSkeletonInsets');
    }
    return context;
};
