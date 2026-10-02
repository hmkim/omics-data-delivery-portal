import { render, screen, waitFor } from '@testing-library/react';
import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import type { ObjectStatusRequest, ObjectStatusResponse } from '@genome-portal/contract';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { resources } from '../i18n';
import { onStorageBrowserValueChange, resetLocation } from '../ui/locationStore';
import { createPortalDataTable, fileRowInfo, isFileListing, type DataTableProps } from './PortalDataTable';

const GiB = 1024 ** 3;

function fileRow(id: string, name: string, size: number): DataTableProps['rows'][number] {
  return {
    key: id,
    content: [
      {
        key: `checkbox-${id}`,
        type: 'checkbox',
        content: { checked: false, label: `Select ${name}`, id: `checkbox-${id}` },
      },
      {
        key: `name-${id}`,
        type: 'button',
        content: { icon: 'file', label: name, ariaLabel: `${name} file` },
      },
      { key: `type-${id}`, type: 'text', content: { text: 'bam' } },
      { key: `last-modified-${id}`, type: 'date', content: { value: new Date(0), displayValue: 'Jan 1' } },
      { key: `size-${id}`, type: 'number', content: { value: size, displayValue: `${size} B` } },
      { key: `download-${id}`, type: 'button', content: { icon: 'download', ariaLabel: 'download' } },
    ],
  };
}

function folderRow(id: string, name: string): DataTableProps['rows'][number] {
  return {
    key: id,
    content: [
      {
        key: `checkbox-${id}`,
        type: 'checkbox',
        content: { checked: false, label: `Select folder ${name}`, id: `checkbox-${id}` },
      },
      { key: `name-${id}`, type: 'button', content: { icon: 'folder', label: name } },
      { key: `type-${id}`, type: 'text', content: { text: 'Folder' } },
      { key: `last-modified-${id}`, type: 'text', content: { text: '' } },
      { key: `size-${id}`, type: 'text', content: { text: '' } },
      { key: `download-${id}`, type: 'text', content: { text: '' } },
    ],
  };
}

const headers: DataTableProps['headers'] = [
  { key: 'checkbox', type: 'checkbox', content: { checked: false, label: 'all', id: 'header-checkbox' } },
  { key: 'name', type: 'sort', content: { label: 'Name' } },
  { key: 'type', type: 'sort', content: { label: 'Type' } },
  { key: 'last-modified', type: 'sort', content: { label: 'Last modified' } },
  { key: 'size', type: 'sort', content: { label: 'Size' } },
  { key: 'download', type: 'text', content: { text: '' } },
];

describe('PortalDataTable (T3.7)', () => {
  beforeAll(async () => {
    await i18next
      .use(initReactI18next)
      .init({ resources, lng: 'ko', fallbackLng: 'en', interpolation: { escapeValue: false } });
  });
  afterEach(() => resetLocation());

  it('recognises the file listing and extracts file rows only', () => {
    expect(isFileListing(headers)).toBe(true);
    expect(isFileListing([{ key: 'bucket', type: 'text', content: { text: 'Bucket' } }])).toBe(false);
    expect(fileRowInfo(fileRow('1', 'a.bam', 10))).toEqual({ rowKey: '1', name: 'a.bam', size: 10 });
    expect(fileRowInfo(folderRow('2', 'sub/'))).toBeUndefined();
  });

  it('adds count / next path / method columns from POST /objects/status with a single debounced call', async () => {
    const objectStatus = vi.fn<(req: ObjectStatusRequest) => Promise<ObjectStatusResponse>>(async () => ({
      items: [
        { bucket: 'bkt', key: 'projects/DEMO-0001/sample01.g.vcf.gz', count: 1, nextPath: 'CF' as const },
        { bucket: 'bkt', key: 'projects/DEMO-0001/sample02.bam', count: 0, nextPath: 'S3' as const },
      ],
    }));
    onStorageBrowserValueChange({
      actionType: undefined,
      location: {
        id: 'loc',
        bucket: 'bkt',
        prefix: 'projects/DEMO-0001/',
        path: '',
        permissions: ['get', 'list'],
        type: 'PREFIX',
      },
    });
    const Table = createPortalDataTable({
      api: { objectStatus },
      plannerOptions: { hasFileSystemAccess: true },
      debounceMs: 10,
    });
    const rows = [
      fileRow('f1', 'sample01.g.vcf.gz', 12 * GiB),
      fileRow('f2', 'sample02.bam', 150_000_000_000),
      fileRow('f3', 'report.pdf', 100_000),
      folderRow('d1', 'sub/'),
    ];
    render(<Table headers={headers} rows={rows} />);
    expect(screen.getByText('다운로드 횟수')).toBeInTheDocument();
    expect(screen.getByText('다음 경로')).toBeInTheDocument();
    expect(screen.getByText('방식')).toBeInTheDocument();
    await waitFor(() => expect(objectStatus).toHaveBeenCalledTimes(1));
    expect(objectStatus.mock.calls[0]?.[0]).toEqual({
      items: [
        { bucket: 'bkt', key: 'projects/DEMO-0001/sample01.g.vcf.gz' },
        { bucket: 'bkt', key: 'projects/DEMO-0001/sample02.bam' },
        { bucket: 'bkt', key: 'projects/DEMO-0001/report.pdf' },
      ],
    });
    await waitFor(() => expect(screen.getByText('CloudFront')).toBeInTheDocument());
    expect(screen.getAllByText('분할·이어받기')).toHaveLength(2); // 12 GiB and 150 GB with FS Access
    expect(screen.queryByText('명령어 다운로드')).not.toBeInTheDocument();
    expect(screen.getByText('S3 직접')).toBeInTheDocument();
    const folder = screen.getByText('sub/').closest('tr') as HTMLTableRowElement;
    const cells = Array.from(folder.querySelectorAll('td'))
      .slice(-3)
      .map((td) => td.textContent);
    expect(cells).toEqual(['', '', '']);
    // e2e selectors (web/e2e): the portal columns carry stable test ids in every row, folder rows included
    expect(screen.getAllByTestId('portal-count')).toHaveLength(4);
    expect(screen.getAllByTestId('portal-next')).toHaveLength(4);
    expect(screen.getAllByTestId('portal-method')).toHaveLength(4);
    expect(folder.querySelector('[data-testid="portal-method"]')?.textContent).toBe('');
  });

  it('without File System Access the 150 GB row shows "명령어 다운로드" and 12 GiB shows nothing (R5.9)', async () => {
    onStorageBrowserValueChange({
      actionType: undefined,
      location: {
        id: 'loc',
        bucket: 'bkt',
        prefix: 'p/',
        path: '',
        permissions: ['get', 'list'],
        type: 'PREFIX',
      },
    });
    const Table = createPortalDataTable({
      api: { objectStatus: async () => ({ items: [] }) },
      plannerOptions: { hasFileSystemAccess: false },
      debounceMs: 1,
    });
    render(
      <Table
        headers={headers}
        rows={[fileRow('a', 'big.bam', 150_000_000_000), fileRow('b', 'mid.vcf', 12 * GiB)]}
      />,
    );
    expect(screen.getByText('명령어 다운로드')).toBeInTheDocument();
    expect(screen.queryByText('분할·이어받기')).not.toBeInTheDocument();
  });

  it('renders non-listing tables without the portal columns; the locations table drops the bucket column', () => {
    const Table = createPortalDataTable({ api: { objectStatus: vi.fn() } });
    render(
      <Table
        headers={[
          { key: 'folder', type: 'text', content: { text: '폴더' } },
          { key: 'bucket', type: 'text', content: { text: '버킷' } },
          { key: 'permission', type: 'text', content: { text: '권한' } },
        ]}
        rows={[
          {
            key: 'r',
            content: [
              { key: 'folder-r', type: 'text', content: { text: 'projects/DEMO-0001/' } },
              {
                key: 'bucket-r',
                type: 'text',
                content: { text: 'genome-portal-data-111111111111-ap-northeast-2' },
              },
              { key: 'permission-r', type: 'text', content: { text: '읽기' } },
            ],
          },
        ]}
      />,
    );
    expect(screen.getByText('projects/DEMO-0001/')).toBeInTheDocument();
    expect(screen.getByText('읽기')).toBeInTheDocument();
    expect(screen.queryByText('버킷')).not.toBeInTheDocument();
    expect(screen.queryByText(/111111111111/)).not.toBeInTheDocument();
    expect(screen.queryByText('다운로드 횟수')).not.toBeInTheDocument();
    expect(screen.getAllByRole('columnheader')).toHaveLength(2);
  });

  it('a non-listing table without a bucket column is rendered unchanged', () => {
    const Table = createPortalDataTable({ api: { objectStatus: vi.fn() } });
    render(
      <Table
        headers={[{ key: 'status', type: 'text', content: { text: 'Status' } }]}
        rows={[{ key: 'r', content: [{ key: 'status-r', type: 'text', content: { text: 'queued' } }] }]}
      />,
    );
    expect(screen.getByText('queued')).toBeInTheDocument();
    expect(screen.getAllByRole('columnheader')).toHaveLength(1);
  });
});
