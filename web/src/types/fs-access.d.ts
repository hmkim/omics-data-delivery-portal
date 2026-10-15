/**
 * File System Access API surface used by the split download engine.
 * TypeScript's DOM lib ships FileSystemFileHandle / FileSystemWritableFileStream but not
 * `window.showSaveFilePicker` or `FileSystemHandle.requestPermission` (WICG), so they are declared here.
 */
interface SaveFilePickerType {
  description?: string;
  accept?: Record<string, string[]>;
}

interface SaveFilePickerOptions {
  suggestedName?: string;
  excludeAcceptAllOption?: boolean;
  types?: SaveFilePickerType[];
  id?: string;
  startIn?: string;
}

interface FileSystemHandlePermissionDescriptor {
  mode?: 'read' | 'readwrite';
}

interface FileSystemHandle {
  queryPermission?(descriptor?: FileSystemHandlePermissionDescriptor): Promise<PermissionState>;
  requestPermission?(descriptor?: FileSystemHandlePermissionDescriptor): Promise<PermissionState>;
}

interface Window {
  showSaveFilePicker?(options?: SaveFilePickerOptions): Promise<FileSystemFileHandle>;
  /**
   * Test-only hook installed by the Playwright e2e suite (`web/e2e`): replaces the native save dialog with a
   * handle the test controls (an OPFS file). Never set by production code.
   */
  __portalTest?: {
    pickFile?(suggestedName: string): Promise<FileSystemFileHandle>;
    /** force the export delivery path (design §5.4 D8); the real choice is transferable-stream support */
    forceExport?: 'stream' | 'blob';
  };
}
