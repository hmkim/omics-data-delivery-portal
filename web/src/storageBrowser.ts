import {
  createStorageBrowser,
  defaultActionConfigs,
  type ListLocationsOutput,
  type LocationData,
} from '@aws-amplify/ui-react-storage/browser';
import { PREVIEW_MAX_BYTES, type ListLocationsResponse } from '@genome-portal/contract';
import { Hub } from 'aws-amplify/utils';
import { api } from './api/client';
import { getConfig } from './config';
import { PdfPreview } from './components/PdfPreview';
import { PortalDataTable } from './components/PortalDataTable';
import { portalDownloadHandler } from './download/handler';

/**
 * Storage Browser wiring (design §2.3, §5.2, T3.5): customer-managed auth backed by our API, a single
 * `download` action with the portal handler, read-only preview policy, and the row-status DataTable.
 */

export type PortalFileType = 'text' | 'pdf' | 'unsupported';

const TEXT_EXTENSIONS = ['.md5', '.txt', '.tsv', '.csv', '.md', '.log'];

/** R3.4: small text files and PDF reports preview; FASTQ/BAM/CRAM/VCF and everything else is "download to view". */
export function portalFileTypeResolver(file: { key: string }): PortalFileType {
  const lower = file.key.toLowerCase();
  if (TEXT_EXTENSIONS.some((ext) => lower.endsWith(ext))) return 'text';
  if (lower.endsWith('.pdf')) return 'pdf';
  return 'unsupported';
}

/** Storage Browser expresses `maxFileSize` in kilobytes. */
export const PREVIEW_MAX_KB = Math.floor(PREVIEW_MAX_BYTES / 1024);

export function toLocationData(res: ListLocationsResponse): ListLocationsOutput {
  const items: LocationData[] = res.items.map((item) => ({
    id: item.id,
    bucket: item.bucket,
    prefix: item.prefix,
    type: item.type,
    permissions: item.permissions,
  }));
  return { items, nextToken: res.nextToken };
}

/** Storage Browser asks with `permissions: ['get','list']`; the API takes the Access Grants form. */
export function toPermission(permissions: readonly string[]): 'READ' | 'READWRITE' {
  return permissions.includes('write') || permissions.includes('delete') ? 'READWRITE' : 'READ';
}

const hidden = { hide: () => true };

export function createPortalStorageBrowser() {
  const cfg = getConfig();
  return createStorageBrowser({
    config: {
      region: cfg.region,
      accountId: cfg.accountId,
      listLocations: async () => toLocationData(await api.listLocations()),
      getLocationCredentials: async ({ scope, permissions }) => {
        const res = await api.getCredentials({ scope, permission: toPermission(permissions) });
        return { scope, credentials: res.credentials };
      },
      registerAuthListener: (onStateChange) => {
        Hub.listen('auth', ({ payload }) => {
          if (payload.event === 'signedOut') onStateChange();
        });
      },
    },
    actions: {
      default: {
        // D3-A: one Download button. The library requires every default config object to exist, so the
        // write actions are kept but hidden from the action list (they would also fail: READ-only grants, R2.5).
        upload: {
          ...defaultActionConfigs.upload,
          actionListItem: { ...defaultActionConfigs.upload.actionListItem, ...hidden },
        },
        delete: {
          ...defaultActionConfigs.delete,
          actionListItem: { ...defaultActionConfigs.delete.actionListItem, ...hidden },
        },
        copy: {
          ...defaultActionConfigs.copy,
          actionListItem: { ...defaultActionConfigs.copy.actionListItem, ...hidden },
        },
        createFolder: {
          ...defaultActionConfigs.createFolder,
          actionListItem: { ...defaultActionConfigs.createFolder.actionListItem, ...hidden },
        },
        download: { ...defaultActionConfigs.download, handler: portalDownloadHandler },
      },
    },
    components: { DataTable: PortalDataTable },
    filePreview: {
      maxFileSize: () => PREVIEW_MAX_KB,
      fileTypeResolver: portalFileTypeResolver,
      // 'unsupported' has no renderer on purpose: the library then shows the LocationDetailView.filePreview
      // unsupported* display text, which carries the "download to view" wording.
      rendererResolver: (fileType) => (fileType === 'pdf' ? PdfPreview : undefined),
    },
  });
}

export type PortalStorageBrowser = ReturnType<typeof createPortalStorageBrowser>;
