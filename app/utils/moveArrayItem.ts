export function moveArrayItem<T>(items: readonly T[], fromIndex: number, toIndex: number) {
    if (fromIndex < 0 || fromIndex >= items.length) {
        return [...items];
    }

    const item = items[fromIndex]!;
    const withoutItem = items.filter((_, index) => index !== fromIndex);
    return [
        ...withoutItem.slice(0, toIndex),
        item,
        ...withoutItem.slice(toIndex),
    ];
}
