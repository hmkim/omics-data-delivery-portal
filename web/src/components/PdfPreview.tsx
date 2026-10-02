import type { CreateStorageBrowserInput } from '@aws-amplify/ui-react-storage/browser';
import { type ComponentProps, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * PDF renderer for the Storage Browser file preview (R3.4). The preview URL is issued with
 * `Content-Disposition: attachment`, which an `<iframe src>` would download instead of display, so the
 * document (≤ 10 MB by the preview size limit) is fetched with the browsing credentials and shown from a blob URL.
 * Preview reads do not count as downloads.
 */
type FilePreviewConfig = Exclude<NonNullable<CreateStorageBrowserInput['filePreview']>, false>;
type RendererResolver = NonNullable<FilePreviewConfig['rendererResolver']>;
/** `{ fileData, url }` — the props the library passes to a custom preview renderer. */
export type PreviewRendererProps = ComponentProps<NonNullable<ReturnType<RendererResolver>>>;

export function PdfPreview({ url, fileData }: PreviewRendererProps) {
  const { t } = useTranslation();
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let objectUrl: string | null = null;
    const controller = new AbortController();
    setBlobUrl(null);
    setError(null);
    fetch(url, { signal: controller.signal, mode: 'cors', credentials: 'omit' })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const blob = await res.blob();
        objectUrl = URL.createObjectURL(new Blob([blob], { type: 'application/pdf' }));
        setBlobUrl(objectUrl);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [url]);

  if (error) {
    return (
      <p role="alert">{t('storageBrowser.LocationDetailView.filePreview.textErrorMessage', { error })}</p>
    );
  }
  if (!blobUrl) {
    return <p>{t('app.loading')}</p>;
  }
  return <iframe title={fileData.key} src={blobUrl} style={{ width: '100%', height: '70vh', border: 0 }} />;
}
