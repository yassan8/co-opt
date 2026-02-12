import { storageGetItem, storageSetItem } from './ui-storage-gateway.ts';

export function getToolbarCollapsed(): boolean {
  try {
    return storageGetItem('toolbarCollapsed') === '1';
  } catch (_) {
    return false;
  }
}

export function setToolbarCollapsed(collapsed: boolean): void {
  try {
    storageSetItem('toolbarCollapsed', collapsed ? '1' : '0');
  } catch (_) {
    // ignore
  }
}
