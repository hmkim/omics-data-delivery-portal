import type { StorageBrowserDisplayText } from '@aws-amplify/ui-react-storage/browser';
import type { TFunction } from 'i18next';

type MessageType = 'info' | 'error' | 'warning' | 'success';
type Counts =
  { COMPLETE?: number; FAILED?: number; TOTAL?: number; OVERWRITE_PREVENTED?: number } | undefined;

/**
 * Builds the full Storage Browser `displayText` object for the active language.
 * All strings come from `i18n/{ko,en}.json` under `storageBrowser.*`; the resolver functions the
 * library expects are assembled here so that the JSON dictionaries stay pure key/value (testable for parity).
 */
export function buildDisplayText(t: TFunction, lang: string): StorageBrowserDisplayText {
  const sb = (key: string, opts?: Record<string, unknown>) => t(`storageBrowser.${key}`, opts) as string;
  const shared = {
    actionCancelLabel: sb('shared.actionCancelLabel'),
    actionExitLabel: sb('shared.actionExitLabel'),
    actionDestinationLabel: sb('shared.actionDestinationLabel'),
    statusDisplayCanceledLabel: sb('shared.statusDisplayCanceledLabel'),
    statusDisplayCompletedLabel: sb('shared.statusDisplayCompletedLabel'),
    statusDisplayLoadedLabel: sb('shared.statusDisplayLoadedLabel'),
    statusDisplayFailedLabel: sb('shared.statusDisplayFailedLabel'),
    statusDisplayInProgressLabel: sb('shared.statusDisplayInProgressLabel'),
    statusDisplayFinishingLabel: sb('shared.statusDisplayFinishingLabel'),
    statusDisplayTotalLabel: sb('shared.statusDisplayTotalLabel'),
    statusDisplayQueuedLabel: sb('shared.statusDisplayQueuedLabel'),
    tableColumnCancelHeader: sb('shared.tableColumnCancelHeader'),
    tableColumnStatusHeader: sb('shared.tableColumnStatusHeader'),
    tableColumnFolderHeader: sb('shared.tableColumnFolderHeader'),
    tableColumnNameHeader: sb('shared.tableColumnNameHeader'),
    tableColumnTypeHeader: sb('shared.tableColumnTypeHeader'),
    tableColumnSizeHeader: sb('shared.tableColumnSizeHeader'),
    tableColumnProgressHeader: sb('shared.tableColumnProgressHeader'),
  };
  const listShared = {
    loadingIndicatorLabel: sb('shared.loadingIndicatorLabel'),
    searchSubmitLabel: sb('shared.searchSubmitLabel'),
    searchClearLabel: sb('shared.searchClearLabel'),
    getDateDisplayValue: (date: Date) =>
      new Intl.DateTimeFormat(lang === 'ko' ? 'ko-KR' : 'en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: 'numeric',
      }).format(date),
  };

  const listMessage =
    (view: 'LocationsView' | 'LocationDetailView') =>
    (data?: {
      items?: unknown[] | undefined;
      hasError?: boolean;
      message?: string;
      hasExhaustedSearch?: boolean;
      isLoading?: boolean;
    }): { content?: string; type?: MessageType } | undefined => {
      const { items, hasError = false, message, hasExhaustedSearch, isLoading } = data ?? {};
      if (isLoading) return undefined;
      if (hasError) return { type: 'error', content: message ?? sb(`${view}.errorLoading`) };
      if (!items?.length && hasExhaustedSearch)
        return { type: 'info', content: sb('shared.noResultsFirst10000') };
      if (!items?.length)
        return {
          type: 'info',
          content: sb(view === 'LocationsView' ? 'LocationsView.noItems' : 'LocationDetailView.noFiles'),
        };
      if (hasExhaustedSearch) return { type: 'info', content: sb('shared.showingFirst10000') };
      return undefined;
    };

  return {
    LocationsView: {
      ...listShared,
      title: sb('LocationsView.title'),
      searchPlaceholder: sb('LocationsView.searchPlaceholder'),
      getListLocationsResultMessage: listMessage('LocationsView'),
      getPermissionName: (permissions) => {
        const read = permissions.includes('get') || permissions.includes('list');
        const write = permissions.includes('write') || permissions.includes('delete');
        if (read && write) return sb('LocationsView.permissionReadWrite');
        if (write) return sb('LocationsView.permissionWrite');
        if (read) return sb('LocationsView.permissionRead');
        return permissions.join('/');
      },
      getDownloadLabel: (fileName) => sb('LocationsView.downloadLabel', { fileName }),
      tableColumnBucketHeader: sb('LocationsView.tableColumnBucketHeader'),
      tableColumnFolderHeader: sb('LocationsView.tableColumnFolderHeader'),
      tableColumnPermissionsHeader: sb('LocationsView.tableColumnPermissionsHeader'),
      tableColumnActionsHeader: sb('LocationsView.tableColumnActionsHeader'),
    },
    LocationDetailView: {
      ...listShared,
      getListItemsResultMessage: listMessage('LocationDetailView'),
      searchSubfoldersToggleLabel: sb('LocationDetailView.searchSubfoldersToggleLabel'),
      searchPlaceholder: sb('LocationDetailView.searchPlaceholder'),
      tableColumnLastModifiedHeader: sb('LocationDetailView.tableColumnLastModifiedHeader'),
      tableColumnNameHeader: sb('LocationDetailView.tableColumnNameHeader'),
      tableColumnSizeHeader: sb('LocationDetailView.tableColumnSizeHeader'),
      tableColumnTypeHeader: sb('LocationDetailView.tableColumnTypeHeader'),
      selectFileLabel: sb('LocationDetailView.selectFileLabel'),
      selectFolderLabel: sb('LocationDetailView.selectFolderLabel'),
      selectAllFilesLabel: sb('LocationDetailView.selectAllFilesLabel'),
      getActionListItemLabel: (key = '') => {
        switch (key) {
          case 'Copy':
            return sb('LocationDetailView.actionCopy');
          case 'Delete':
            return sb('LocationDetailView.actionDelete');
          case 'Create folder':
            return sb('LocationDetailView.actionCreateFolder');
          case 'Upload':
            return sb('LocationDetailView.actionUpload');
          case 'Download':
            return sb('LocationDetailView.actionDownload');
          default:
            return key;
        }
      },
      getTitle: (location) => {
        const { current, key } = location;
        return key || (current?.bucket ?? '');
      },
      filePreview: {
        closeButtonLabel: sb('LocationDetailView.filePreview.closeButtonLabel'),
        filePreviewTitle: sb('LocationDetailView.filePreview.filePreviewTitle'),
        fileInformationTitle: sb('LocationDetailView.filePreview.fileInformationTitle'),
        errorMessage: sb('LocationDetailView.filePreview.errorMessage'),
        sizeLimitMessage: sb('LocationDetailView.filePreview.sizeLimitMessage'),
        unsupportedFileMessage: sb('LocationDetailView.filePreview.unsupportedFileMessage'),
        keyLabel: sb('LocationDetailView.filePreview.keyLabel'),
        sizeLabel: sb('LocationDetailView.filePreview.sizeLabel'),
        versionIdLabel: sb('LocationDetailView.filePreview.versionIdLabel'),
        lastModifiedLabel: sb('LocationDetailView.filePreview.lastModifiedLabel'),
        entityTagLabel: sb('LocationDetailView.filePreview.entityTagLabel'),
        typeLabel: sb('LocationDetailView.filePreview.typeLabel'),
        unknownValue: sb('LocationDetailView.filePreview.unknownValue'),
        errorDescription: sb('LocationDetailView.filePreview.errorDescription'),
        unsupportedFileDescription: sb('LocationDetailView.filePreview.unsupportedFileDescription'),
        imageLoadErrorDescription: sb('LocationDetailView.filePreview.imageLoadErrorDescription'),
        videoLoadErrorDescription: sb('LocationDetailView.filePreview.videoLoadErrorDescription'),
        textLoadErrorDescription: sb('LocationDetailView.filePreview.textLoadErrorDescription'),
        generalPreviewErrorDescription: sb('LocationDetailView.filePreview.generalPreviewErrorDescription'),
        fileSizeLimitDescription: sb('LocationDetailView.filePreview.fileSizeLimitDescription'),
        filePrefix: sb('LocationDetailView.filePreview.filePrefix'),
        retryButtonLabel: sb('LocationDetailView.filePreview.retryButtonLabel'),
        downloadButtonLabel: sb('LocationDetailView.filePreview.downloadButtonLabel'),
        getTextErrorMessage: (error) => sb('LocationDetailView.filePreview.textErrorMessage', { error }),
        emptyFileMessage: sb('LocationDetailView.filePreview.emptyFileMessage'),
      },
    },
    DownloadView: {
      ...shared,
      title: sb('DownloadView.title'),
      actionStartLabel: sb('DownloadView.actionStartLabel'),
      statusDisplayFinishingLabel: sb('DownloadView.statusDisplayFinishingLabel'),
      statusDisplayLoadedLabel: sb('DownloadView.statusDisplayLoadedLabel'),
      getActionCompleteMessage: (data) => {
        const { COMPLETE = 0, FAILED = 0, TOTAL = 0 } = (data?.counts ?? {}) as NonNullable<Counts>;
        if (COMPLETE === TOTAL) return { content: sb('DownloadView.allDownloaded'), type: 'success' };
        if (FAILED === TOTAL) return { content: sb('DownloadView.allFailed'), type: 'error' };
        return { content: sb('DownloadView.partial', { complete: COMPLETE, failed: FAILED }), type: 'error' };
      },
      tableColumnProgressHeader: sb('DownloadView.tableColumnProgressHeader'),
      enumeratingMessage: sb('DownloadView.enumeratingMessage'),
      enumerationErrorMessage: sb('DownloadView.enumerationErrorMessage'),
      noFilesMessage: sb('DownloadView.noFilesMessage'),
      tooManyFilesMessage: sb('DownloadView.tooManyFilesMessage'),
    },
    UploadView: {
      ...shared,
      title: sb('UploadView.title'),
      actionStartLabel: sb('UploadView.actionStartLabel'),
      addFilesLabel: sb('UploadView.addFilesLabel'),
      addFolderLabel: sb('UploadView.addFolderLabel'),
      overwriteToggleLabel: sb('UploadView.overwriteToggleLabel'),
      statusDisplayOverwritePreventedLabel: sb('UploadView.statusDisplayOverwritePreventedLabel'),
      tableColumnProgressHeader: sb('UploadView.tableColumnProgressHeader'),
      getActionCompleteMessage: (data) => {
        const { COMPLETE = 0, FAILED = 0, TOTAL = 0 } = (data?.counts ?? {}) as NonNullable<Counts>;
        if (COMPLETE === TOTAL) return { content: sb('UploadView.allUploaded'), type: 'success' };
        if (FAILED === TOTAL) return { content: sb('UploadView.allFailed'), type: 'error' };
        return { content: sb('UploadView.partial', { complete: COMPLETE, failed: FAILED }), type: 'error' };
      },
      getFilesValidationMessage: (data) =>
        data?.invalidFiles?.length ? { content: sb('UploadView.invalidFiles'), type: 'error' } : undefined,
    },
    DeleteView: {
      ...shared,
      title: sb('DeleteView.title'),
      actionStartLabel: sb('DeleteView.actionStartLabel'),
      confirmationModalTitle: sb('DeleteView.confirmationModalTitle'),
      confirmationModalConfirmLabel: sb('DeleteView.confirmationModalConfirmLabel'),
      confirmationModalCancelLabel: sb('DeleteView.confirmationModalCancelLabel'),
      confirmationModalMessage: sb('DeleteView.confirmationModalMessage'),
      confirmationModalFolderListTitle: sb('DeleteView.confirmationModalFolderListTitle'),
      getActionCompleteMessage: (data) => {
        const { COMPLETE = 0, FAILED = 0, TOTAL = 0 } = (data?.counts ?? {}) as NonNullable<Counts>;
        if (!TOTAL) return { content: sb('DeleteView.noItems'), type: 'info' };
        if (COMPLETE === TOTAL) return { content: sb('DeleteView.allDeleted'), type: 'success' };
        if (FAILED === TOTAL) return { content: sb('DeleteView.allFailed'), type: 'error' };
        return { content: sb('DeleteView.partial', { complete: COMPLETE, failed: FAILED }), type: 'error' };
      },
    },
    CopyView: {
      ...shared,
      title: sb('CopyView.title'),
      actionStartLabel: sb('CopyView.actionStartLabel'),
      actionDestinationLabel: sb('CopyView.actionDestinationLabel'),
      loadingIndicatorLabel: 'Loading',
      overwriteWarningMessage: sb('CopyView.overwriteWarningMessage'),
      searchPlaceholder: sb('CopyView.searchPlaceholder'),
      searchSubmitLabel: sb('shared.searchSubmitLabel'),
      searchClearLabel: sb('shared.searchClearLabel'),
      getListFoldersResultsMessage: ({ folders, query, message, hasError, hasExhaustedSearch }) => {
        if (!folders?.length) {
          return {
            content: query ? sb('CopyView.noFoldersMatching', { query }) : sb('CopyView.noSubfolders'),
            type: 'info',
          };
        }
        if ((message && !!query) || hasError)
          return { content: sb('CopyView.errorLoadingFolders'), type: 'error' };
        if (hasExhaustedSearch) return { content: sb('shared.showingFirst10000'), type: 'info' };
        return undefined;
      },
      getActionCompleteMessage: (data) => {
        const { COMPLETE = 0, FAILED = 0, TOTAL = 0 } = (data?.counts ?? {}) as NonNullable<Counts>;
        if (COMPLETE === TOTAL) return { content: sb('CopyView.allCopied'), type: 'success' };
        if (FAILED === TOTAL) return { content: sb('CopyView.allFailed'), type: 'error' };
        return { content: sb('CopyView.partial', { complete: COMPLETE, failed: FAILED }), type: 'error' };
      },
    },
    CreateFolderView: {
      actionCancelLabel: shared.actionCancelLabel,
      actionExitLabel: shared.actionExitLabel,
      actionDestinationLabel: shared.actionDestinationLabel,
      title: sb('CreateFolderView.title'),
      actionStartLabel: sb('CreateFolderView.actionStartLabel'),
      folderNameLabel: sb('CreateFolderView.folderNameLabel'),
      folderNamePlaceholder: sb('CreateFolderView.folderNamePlaceholder'),
      getValidationMessage: () => sb('CreateFolderView.validationMessage'),
      getActionCompleteMessage: (data) => {
        const { FAILED, OVERWRITE_PREVENTED } = (data?.counts ?? {}) as NonNullable<Counts>;
        if (OVERWRITE_PREVENTED) return { content: sb('CreateFolderView.alreadyExists'), type: 'warning' };
        if (FAILED) return { content: sb('CreateFolderView.createFailed'), type: 'error' };
        return { content: sb('CreateFolderView.created'), type: 'success' };
      },
    },
  };
}
