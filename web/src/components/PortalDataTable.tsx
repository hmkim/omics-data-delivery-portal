import type { CreateStorageBrowserInput } from '@aws-amplify/ui-react-storage/browser';
import {
  Button,
  CheckboxField,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
} from '@aws-amplify/ui-react';
import { OBJECT_STATUS_MAX_ITEMS, type ObjectStatusItem } from '@genome-portal/contract';
import { type ComponentProps, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { api, type ApiClient } from '../api/client';
import { decide, type DecideOptions } from '../download/planner';
import { getCurrentLocation, subscribeLocation } from '../ui/locationStore';

/**
 * `components.DataTable` override (design §5.1, R3.5). Renders every Storage Browser table (locations, files,
 * task lists) and, for the LocationDetailView file listing (headers `name`/`size`/`download`), appends three
 * columns: download count and next path from `POST /objects/status` (300 ms debounce, ≤ 100 keys per page),
 * and the planner badge (split → "분할·이어받기", command → "명령어 다운로드", single → empty). Folder rows stay empty.
 *
 * The library does not export its default DataTable from the public entry point, so the table itself is rendered
 * here with Amplify UI primitives against the same `DataTableProps` shape (derived from `CreateStorageBrowserInput`).
 */
type DataTableComponent = NonNullable<NonNullable<CreateStorageBrowserInput['components']>['DataTable']>;
export type DataTableProps = ComponentProps<DataTableComponent>;
type Header = DataTableProps['headers'][number];
type Row = DataTableProps['rows'][number];
type Cell = Row['content'][number];

export const STATUS_DEBOUNCE_MS = 300;

interface FileRowInfo {
  rowKey: string;
  name: string;
  size: number;
}

/** A LocationDetailView table has `download`, `size` and `name` headers; task and location tables do not. */
export function isFileListing(headers: DataTableProps['headers']): boolean {
  const keys = new Set(headers.map((h: Header) => h.key));
  return keys.has('download') && keys.has('size') && keys.has('name');
}

/**
 * LocationsView lists `folder | bucket | permission`. Every customer organisation is scoped to the single data
 * bucket, so the column is noise for them — and the bucket name embeds the AWS account id, which end users have no
 * reason to see (dev 2026-10-01 review). Cells are positional, so the header and its cell are dropped by index.
 */
export function withoutBucketColumn(props: DataTableProps): DataTableProps {
  const idx = props.headers.findIndex((h: Header) => h.key === 'bucket');
  if (idx < 0) return props;
  const drop = <T,>(cells: T[]): T[] => cells.filter((_, i) => i !== idx);
  return {
    ...props,
    headers: drop(props.headers),
    rows: props.rows.map((row: Row) => ({ ...row, content: drop(row.content) })),
  };
}

function cellByPrefix(row: Row, prefix: string): Cell | undefined {
  return row.content.find((c: Cell) => c.key.startsWith(`${prefix}-`));
}

/** File rows carry a numeric `size` cell; folder rows have an empty text cell there. */
export function fileRowInfo(row: Row): FileRowInfo | undefined {
  const size = cellByPrefix(row, 'size');
  if (!size || size.type !== 'number' || typeof size.content.value !== 'number') return undefined;
  const nameCell = cellByPrefix(row, 'name');
  if (!nameCell) return undefined;
  const name =
    nameCell.type === 'button'
      ? nameCell.content.label
      : nameCell.type === 'text'
        ? nameCell.content.text
        : undefined;
  if (!name) return undefined;
  return { rowKey: row.key, name, size: size.content.value };
}

const ICON_GLYPHS: Record<string, string> = {
  download: '⬇',
  folder: '📁',
  file: '📄',
  'file-text': '📄',
  'file-pdf': '📕',
  'file-image': '🖼',
  'file-archive': '🗜',
  'file-excel': '📊',
};

function HeaderCell({ header }: { header: Header }) {
  switch (header.type) {
    case 'checkbox':
      return (
        <TableCell as="th">
          <CheckboxField
            name={header.content.id ?? header.key}
            label={header.content.label ?? ''}
            labelHidden
            checked={header.content.checked ?? false}
            onChange={() => header.content.onSelect?.()}
          />
        </TableCell>
      );
    case 'sort':
      return (
        <TableCell as="th" aria-sort={header.content.sortDirection}>
          {header.content.onSort ? (
            <Button variation="link" size="small" onClick={header.content.onSort}>
              {header.content.label}
            </Button>
          ) : (
            header.content.label
          )}
        </TableCell>
      );
    case 'text':
    default:
      return <TableCell as="th">{header.content.text}</TableCell>;
  }
}

/** Portal-added columns carry a stable `data-testid` (`portal-count` / `portal-next` / `portal-method`) for e2e. */
function portalColumnTestId(cellKey: string): string | undefined {
  const m = /^(portal-(?:count|next|method))-/.exec(cellKey);
  return m?.[1];
}

function DataCell({ cell }: { cell: Cell }) {
  const testId = portalColumnTestId(cell.key);
  switch (cell.type) {
    case 'button': {
      const glyph = cell.content.icon ? ICON_GLYPHS[cell.content.icon] : undefined;
      return (
        <TableCell>
          <Button
            variation="link"
            size="small"
            onClick={cell.content.onClick}
            isDisabled={cell.content.isDisabled}
            ariaLabel={cell.content.ariaLabel}
          >
            {glyph ? <span aria-hidden="true">{glyph} </span> : null}
            {cell.content.label}
          </Button>
        </TableCell>
      );
    }
    case 'checkbox':
      return (
        <TableCell>
          <CheckboxField
            name={cell.content.id ?? cell.key}
            label={cell.content.label ?? ''}
            labelHidden
            checked={cell.content.checked ?? false}
            onChange={() => cell.content.onSelect?.()}
          />
        </TableCell>
      );
    case 'date':
      return <TableCell>{cell.content.displayValue ?? cell.content.value?.toISOString() ?? ''}</TableCell>;
    case 'number':
      return (
        <TableCell style={{ textAlign: 'right' }} data-testid={testId}>
          {cell.content.displayValue ?? (cell.content.value !== undefined ? String(cell.content.value) : '')}
        </TableCell>
      );
    case 'text':
    default:
      return (
        <TableCell data-testid={testId}>
          {cell.content.icon && ICON_GLYPHS[cell.content.icon] ? (
            <span aria-hidden="true">{ICON_GLYPHS[cell.content.icon]} </span>
          ) : null}
          {cell.content.text}
        </TableCell>
      );
  }
}

/** Plain renderer for the `DataTableProps` shape. */
export function BaseDataTable({ headers, rows, isLoading }: DataTableProps) {
  return (
    <Table size="small" highlightOnHover className="amplify-storage-browser__table">
      <TableHead>
        <TableRow>
          {headers.map((header: Header) => (
            <HeaderCell key={header.key} header={header} />
          ))}
        </TableRow>
      </TableHead>
      <TableBody>
        {isLoading
          ? null
          : rows.map((row: Row) => (
              <TableRow key={row.key} aria-selected={row.active}>
                {row.content.map((cell: Cell) => (
                  <DataCell key={cell.key} cell={cell} />
                ))}
              </TableRow>
            ))}
      </TableBody>
    </Table>
  );
}

export interface PortalDataTableDeps {
  api: Pick<ApiClient, 'objectStatus'>;
  plannerOptions?: DecideOptions;
  debounceMs?: number;
}

export function createPortalDataTable(deps: PortalDataTableDeps): DataTableComponent {
  const debounceMs = deps.debounceMs ?? STATUS_DEBOUNCE_MS;

  return function PortalDataTable(props: DataTableProps) {
    const { t } = useTranslation();
    const location = useSyncExternalStore(subscribeLocation, getCurrentLocation, getCurrentLocation);
    const listing = isFileListing(props.headers);
    const [statuses, setStatuses] = useState<Record<string, ObjectStatusItem>>({});
    const requestSeq = useRef(0);

    const files = useMemo(() => {
      if (!listing || !location) return [] as Array<FileRowInfo & { key: string }>;
      return props.rows
        .map((row: Row) => fileRowInfo(row))
        .filter((f: FileRowInfo | undefined): f is FileRowInfo => !!f)
        .map((f: FileRowInfo) => ({ ...f, key: `${location.locationKey}${f.name}` }));
    }, [listing, location, props.rows]);

    const fileKeysSignature = files.map((f) => f.key).join('\n');
    const bucket = location?.bucket;
    const locationKey = location?.locationKey;
    const isLoading = props.isLoading;

    useEffect(() => {
      if (!listing || !bucket || files.length === 0 || isLoading) return;
      const seq = ++requestSeq.current;
      const timer = setTimeout(() => {
        const items = files.slice(0, OBJECT_STATUS_MAX_ITEMS).map((f) => ({ bucket, key: f.key }));
        deps.api
          .objectStatus({ items })
          .then((res) => {
            if (seq !== requestSeq.current) return;
            const next: Record<string, ObjectStatusItem> = {};
            for (const item of res.items) next[`${item.bucket}/${item.key}`] = item;
            setStatuses(next);
          })
          .catch(() => {
            if (seq === requestSeq.current) setStatuses({});
          });
      }, debounceMs);
      return () => clearTimeout(timer);
      // `files` is derived from `fileKeysSignature` + location; the signature is the stable dependency
    }, [listing, bucket, locationKey, fileKeysSignature, isLoading]);

    if (!listing) return <BaseDataTable {...withoutBucketColumn(props)} />;

    const extraHeaders: Header[] = [
      { key: 'portal-count', type: 'text', content: { text: t('table.downloadCount') } },
      { key: 'portal-next', type: 'text', content: { text: t('table.nextPath') } },
      { key: 'portal-method', type: 'text', content: { text: t('table.method') } },
    ];
    const byRow = new Map(files.map((f) => [f.rowKey, f]));
    const rows: Row[] = props.rows.map((row: Row) => {
      const info = byRow.get(row.key);
      if (!info || !bucket) {
        return {
          ...row,
          content: [
            ...row.content,
            { key: `portal-count-${row.key}`, type: 'text', content: { text: '' } },
            { key: `portal-next-${row.key}`, type: 'text', content: { text: '' } },
            { key: `portal-method-${row.key}`, type: 'text', content: { text: '' } },
          ],
        };
      }
      const status = statuses[`${bucket}/${info.key}`];
      const mode = decide({ sizeBytes: info.size }, deps.plannerOptions);
      const badge = mode === 'split' ? t('badge.split') : mode === 'command' ? t('badge.command') : '';
      return {
        ...row,
        content: [
          ...row.content,
          {
            key: `portal-count-${row.key}`,
            type: 'number',
            content: status
              ? { value: status.count, displayValue: String(status.count) }
              : { displayValue: t('table.statusLoading') },
          },
          {
            key: `portal-next-${row.key}`,
            type: 'text',
            content: {
              text: status
                ? t(status.nextPath === 'CF' ? 'table.pathCF' : 'table.pathS3')
                : t('table.statusLoading'),
            },
          },
          { key: `portal-method-${row.key}`, type: 'text', content: { text: badge } },
        ],
      };
    });

    return (
      <BaseDataTable headers={[...props.headers, ...extraHeaders]} rows={rows} isLoading={props.isLoading} />
    );
  };
}

export const PortalDataTable = createPortalDataTable({ api });
