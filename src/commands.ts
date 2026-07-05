import * as vscode from 'vscode';
import * as path from 'path';
import { ConnectionManager } from './connectionManager';
import { createClient, uploadFile, downloadFile, deleteObject, deleteFolder, renameObject, renameFolder, createFolder, testConnection, getObjectDetail, listObjects } from './s3Client';
import { S3ExplorerProvider, S3TreeItem } from './treeView';
import { PreviewManager, isTextFile, isPreviewable } from './previewManager';
import { t } from './i18n';
import { JumpHistory } from './jumpHistory';
import { JumpHistoryPanel } from './jumpHistoryPanel';

let jumpHistory: JumpHistory;
let connManager: ConnectionManager;
let s3TreeProvider: S3ExplorerProvider;

export function registerCommands(
  context: vscode.ExtensionContext,
  connectionManager: ConnectionManager,
  treeProvider: S3ExplorerProvider,
  previewManager: PreviewManager,
  history: JumpHistory
): void {
  jumpHistory = history;
  connManager = connectionManager;
  s3TreeProvider = treeProvider;

  context.subscriptions.push(
    vscode.commands.registerCommand('s3.addConnection', () =>
      addConnection(connectionManager, treeProvider)
    ),
    vscode.commands.registerCommand('s3.refresh', (item?: S3TreeItem) =>
      treeProvider.refresh(item)
    ),
    vscode.commands.registerCommand('s3.uploadFile', (item: S3TreeItem) =>
      handleUpload(connectionManager, item)
    ),
    vscode.commands.registerCommand('s3.downloadFile', (item: S3TreeItem) =>
      handleDownload(connectionManager, item)
    ),
    vscode.commands.registerCommand('s3.deleteObject', (item: S3TreeItem) =>
      handleDelete(connectionManager, treeProvider, item)
    ),
    vscode.commands.registerCommand('s3.editConnection', (item: S3TreeItem) =>
      handleEditConnection(connectionManager, treeProvider, item)
    ),
    vscode.commands.registerCommand('s3.deleteConnection', (item: S3TreeItem) =>
      handleDeleteConnection(connectionManager, treeProvider, item)
    ),
    vscode.commands.registerCommand('s3.copyPath', (item: S3TreeItem) =>
      handleCopyPath(item)
    ),
    vscode.commands.registerCommand('s3.previewFile', (item: S3TreeItem) =>
      handlePreviewFile(connectionManager, previewManager, item)
    ),
    vscode.commands.registerCommand('s3.rename', (item: S3TreeItem) =>
      handleRename(connectionManager, treeProvider, item)
    ),
    vscode.commands.registerCommand('s3.newFolder', (item: S3TreeItem) =>
      handleNewFolder(connectionManager, treeProvider, item)
    ),
    vscode.commands.registerCommand('s3.searchFiles', (item: S3TreeItem) =>
      handleSearchFiles(connectionManager, treeProvider, item)
    ),
    vscode.commands.registerCommand('s3.goToPath', (item: S3TreeItem) =>
      handleGoToPath(connectionManager, treeProvider, item)
    ),
    vscode.commands.registerCommand('s3.getInfo', (item: S3TreeItem) =>
      handleGetInfo(connectionManager, item)
    ),
    vscode.commands.registerCommand('s3.jumpHistory', () =>
      handleJumpHistory()
    )
  );
}

function getSelectionOrDefault(item: S3TreeItem, ...validContexts: string[]): S3TreeItem[] {
  const selection = S3ExplorerProvider.treeView?.selection;
  if (selection && selection.length > 1 && selection.includes(item)) {
    return selection.filter(i => validContexts.length === 0 || validContexts.includes(i.contextValue));
  }
  if (item && (validContexts.length === 0 || validContexts.includes(item.contextValue))) {
    return [item];
  }
  return [];
}

async function addConnection(
  connectionManager: ConnectionManager,
  treeProvider: S3ExplorerProvider
): Promise<void> {
  const name = await vscode.window.showInputBox({
    prompt: t('prompt_connectionName'),
    placeHolder: t('prompt_connectionName_placeholder'),
    validateInput: (v) => (v.trim() ? null : t('val_nameRequired')),
    ignoreFocusOut: true,
  });
  if (!name) return;

  const endpoint = await vscode.window.showInputBox({
    prompt: t('prompt_endpoint'),
    placeHolder: t('prompt_endpoint_placeholder'),
    validateInput: (v) => {
      if (!v.trim()) return t('val_endpointRequired');
      try { new URL(v); return null; }
      catch { return t('val_invalidUrl'); }
    },
    ignoreFocusOut: true,
  });
  if (!endpoint) return;

  const region = await vscode.window.showInputBox({
    prompt: t('prompt_region'),
    placeHolder: t('prompt_region_placeholder'),
    value: 'us-east-1',
    ignoreFocusOut: true,
  });
  if (!region) return;

  const bucket = await vscode.window.showInputBox({
    prompt: t('prompt_bucket'),
    placeHolder: t('prompt_bucket_placeholder'),
    validateInput: (v) => (v.trim() ? null : t('val_bucketRequired')),
    ignoreFocusOut: true,
  });
  if (!bucket) return;

  const pathStyleStr = await vscode.window.showQuickPick(
    [
      { label: t('prompt_pathStyle_yes'), description: t('prompt_pathStyle_yes_desc') },
      { label: t('prompt_pathStyle_no'), description: t('prompt_pathStyle_no_desc') },
    ],
    {
      placeHolder: t('prompt_pathStyle'),
      ignoreFocusOut: true,
    }
  );
  if (!pathStyleStr) return;
  const forcePathStyle = pathStyleStr.label === t('prompt_pathStyle_yes');

  const accessKeyId = await vscode.window.showInputBox({
    prompt: t('prompt_accessKey'),
    placeHolder: t('prompt_accessKey_placeholder'),
    validateInput: (v) => (v.trim() ? null : t('val_accessKeyRequired')),
    ignoreFocusOut: true,
  });
  if (!accessKeyId) return;

  const secretAccessKey = await vscode.window.showInputBox({
    prompt: t('prompt_secretKey'),
    placeHolder: t('prompt_secretKey_placeholder'),
    password: true,
    validateInput: (v) => (v.trim() ? null : t('val_secretKeyRequired')),
    ignoreFocusOut: true,
  });
  if (!secretAccessKey) return;

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: t('msg_testingConnection'),
      cancellable: false,
    },
    async () => {
      const conn = await connectionManager.addConnection({
        name, endpoint, region, bucket, forcePathStyle, accessKeyId, secretAccessKey,
      });

      const client = createClient(conn);
      const result = await testConnection(client, bucket);

      if (result.ok) {
        vscode.window.showInformationMessage(t('msg_connected', name));
        treeProvider.refresh();
      } else {
        const action = await vscode.window.showErrorMessage(
          t('msg_connectionFailed', result.error),
          t('msg_removeConn'),
          t('msg_keepAnyway')
        );
        if (action === t('msg_removeConn')) {
          await connectionManager.removeConnection(conn.id);
          treeProvider.refresh();
        }
      }
    }
  );
}

async function handleUpload(
  connectionManager: ConnectionManager,
  item: S3TreeItem
): Promise<void> {
  if (!item) {
    vscode.window.showErrorMessage(t('msg_selectConnOrFolder'));
    return;
  }

  const conn = connectionManager.getConnection(item.connectionId);
  if (!conn) { vscode.window.showErrorMessage(t('msg_connNotFound')); return; }

  const fileUris = await vscode.window.showOpenDialog({
    canSelectFiles: true,
    canSelectMany: true,
    openLabel: t('cmd_uploadFile'),
  });
  if (!fileUris || fileUris.length === 0) return;

  const client = createClient(conn);
  const prefix = item.isFolder ? item.key : '';

  for (const fileUri of fileUris) {
    const filePath = fileUri.fsPath;
    const fileName = path.basename(filePath);
    const key = prefix + fileName;

    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: t('msg_uploading', fileName),
          cancellable: false,
        },
        () => uploadFile(client, conn.bucket, key, filePath)
      );
    } catch (err: any) {
      vscode.window.showErrorMessage(t('msg_uploadFailed', fileName, err.message));
      return;
    }
  }

  vscode.window.showInformationMessage(t('msg_uploaded', fileUris.length));
}

async function handleDownload(
  connectionManager: ConnectionManager,
  item: S3TreeItem
): Promise<void> {
  const items = getSelectionOrDefault(item, 's3File');
  if (items.length === 0) {
    vscode.window.showErrorMessage(t('msg_selectFile'));
    return;
  }

  const files = items.filter(i => i.contextValue === 's3File');
  if (files.length === 0) {
    vscode.window.showErrorMessage(t('msg_selectFile'));
    return;
  }

  const conn = connectionManager.getConnection(files[0].connectionId);
  if (!conn) { vscode.window.showErrorMessage(t('msg_connNotFound')); return; }

  const client = createClient(conn);

  if (files.length === 1) {
    const fileName = path.basename(files[0].key);
    const uri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(fileName),
      saveLabel: t('cmd_downloadFile'),
    });
    if (!uri) return;
    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: t('msg_downloading', fileName), cancellable: false },
        () => downloadFile(client, conn.bucket, files[0].key, uri.fsPath)
      );
      vscode.window.showInformationMessage(t('msg_downloaded', fileName));
    } catch (err: any) {
      vscode.window.showErrorMessage(t('msg_downloadFailed', err.message));
    }
    return;
  }

  const dirUri = await vscode.window.showOpenDialog({
    canSelectFolders: true,
    canSelectFiles: false,
    openLabel: t('cmd_downloadFile'),
  });
  if (!dirUri) return;
  const baseDir = dirUri[0].fsPath;

  let successCount = 0;
  let failCount = 0;

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: t('msg_downloadingMany', files.length), cancellable: false },
    async () => {
      for (const f of files) {
        const localPath = path.join(baseDir, path.basename(f.key));
        try {
          await downloadFile(client, conn.bucket, f.key, localPath);
          successCount++;
        } catch { failCount++; }
      }
    }
  );

  if (failCount === 0) {
    vscode.window.showInformationMessage(t('msg_downloadedMany', successCount, baseDir));
  } else {
    vscode.window.showWarningMessage(t('msg_downloadedWarn', successCount, failCount));
  }
}

async function handleDelete(
  connectionManager: ConnectionManager,
  treeProvider: S3ExplorerProvider,
  item: S3TreeItem
): Promise<void> {
  const items = getSelectionOrDefault(item, 's3File', 's3Folder');
  if (items.length === 0) {
    vscode.window.showErrorMessage(t('msg_selectFileOrFolder'));
    return;
  }

  const conn = connectionManager.getConnection(items[0].connectionId);
  if (!conn) { vscode.window.showErrorMessage(t('msg_connNotFound')); return; }

  const client = createClient(conn);

  const confirmMsg = items.length === 1
    ? items[0].isFolder
      ? t('msg_deleteFolderConfirm', getLabel(items[0].key, true))
      : t('msg_deleteConfirm', getLabel(items[0].key, false))
    : t('msg_deleteMultiConfirm', items.length);

  const confirm = await vscode.window.showWarningMessage(confirmMsg, t('msg_deleteBtn'), t('msg_cancelBtn'));
  if (confirm !== t('msg_deleteBtn')) return;

  let successCount = 0;
  let failCount = 0;

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: t('msg_deleting', items.length), cancellable: false },
    async () => {
      for (const target of items) {
        try {
          if (target.isFolder) {
            await deleteFolder(client, conn.bucket, target.key);
          } else {
            await deleteObject(client, conn.bucket, target.key);
          }
          successCount++;
        } catch { failCount++; }
      }
    }
  );

  treeProvider.refresh();

  if (failCount === 0) {
    vscode.window.showInformationMessage(t('msg_deletedMany', successCount));
  } else {
    vscode.window.showWarningMessage(t('msg_deletedWarn', successCount, failCount));
  }
}

async function handlePreviewFile(
  connectionManager: ConnectionManager,
  previewManager: PreviewManager,
  item: S3TreeItem
): Promise<void> {
  if (!item || item.contextValue !== 's3File') return;

  const conn = connectionManager.getConnection(item.connectionId);
  if (!conn) return;

  if (!isPreviewable(item.key)) {
    vscode.window.showInformationMessage(t('msg_notPreviewable'));
    return;
  }

  const localPath = previewManager.getTempPath(item.connectionId, item.key);
  previewManager.ensureParentDir(localPath);

  const client = createClient(conn);

  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: t('msg_opening'), cancellable: false },
      () => downloadFile(client, conn.bucket, item.key, localPath)
    );

    previewManager.registerMapping(localPath, item.connectionId, conn.bucket, item.key);

    if (isTextFile(item.key)) {
      const doc = await vscode.workspace.openTextDocument(localPath);
      await vscode.window.showTextDocument(doc, { preview: true });
    } else {
      await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(localPath));
    }
  } catch (err: any) {
    vscode.window.showErrorMessage(t('msg_openFailed', err.message));
  }
}

async function handleRename(
  connectionManager: ConnectionManager,
  treeProvider: S3ExplorerProvider,
  item: S3TreeItem
): Promise<void> {
  if (!item || (item.contextValue !== 's3File' && item.contextValue !== 's3Folder')) {
    vscode.window.showErrorMessage(t('msg_selectFileOrFolder'));
    return;
  }

  const conn = connectionManager.getConnection(item.connectionId);
  if (!conn) { vscode.window.showErrorMessage(t('msg_connNotFound')); return; }

  const client = createClient(conn);
  const oldName = getLabel(item.key, item.isFolder);
  const prefixPath = item.isFolder
    ? item.key.slice(0, -oldName.length)
    : item.key.slice(0, -oldName.length);

  const dotIdx = oldName.lastIndexOf('.');
  const selectLen = dotIdx > 0 ? dotIdx : oldName.length;

  const validateName = (v: string): string | null => {
    if (!v.trim()) return t('val_empty');
    if (v.includes('/')) return t('val_slash');
    if (/^\.+$/.test(v)) return t('val_dots');
    if (/[<>:"|?*\\]/.test(v)) return t('val_invalidChars');
    return null;
  };

  const newName = await vscode.window.showInputBox({
    title: item.isFolder ? t('prompt_rename_folder') : t('prompt_rename_file'),
    value: oldName,
    valueSelection: [0, selectLen],
    validateInput: validateName,
    ignoreFocusOut: true,
  });
  if (!newName || newName === oldName) return;
  if (validateName(newName)) {
    vscode.window.showWarningMessage(t('msg_renameBad'));
    return;
  }

  const oldKey = item.key;
  const newKey = item.isFolder ? prefixPath + newName + '/' : prefixPath + newName;

  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: t('msg_renaming'), cancellable: false },
      async () => {
        if (item.isFolder) await renameFolder(client, conn.bucket, oldKey, newKey);
        else await renameObject(client, conn.bucket, oldKey, newKey);
      }
    );
    treeProvider.refresh();
  } catch (err: any) {
    vscode.window.showErrorMessage(t('msg_renameFailed', err.message));
  }
}

async function handleNewFolder(
  connectionManager: ConnectionManager,
  treeProvider: S3ExplorerProvider,
  item: S3TreeItem
): Promise<void> {
  if (!item || (item.contextValue !== 's3Connection' && item.contextValue !== 's3Folder')) {
    vscode.window.showErrorMessage(t('msg_selectConnOrFolder'));
    return;
  }

  const conn = connectionManager.getConnection(item.connectionId);
  if (!conn) { vscode.window.showErrorMessage(t('msg_connNotFound')); return; }

  const client = createClient(conn);
  const parentPrefix = item.contextValue === 's3Folder' ? item.key : '';

  const folderName = await vscode.window.showInputBox({
    prompt: t('prompt_newFolderName'),
    placeHolder: t('prompt_newFolder_placeholder'),
    validateInput: (v) => (v.trim() ? null : t('val_nameRequired')),
    ignoreFocusOut: true,
  });
  if (!folderName) return;

  const fullKey = parentPrefix + folderName;

  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: t('msg_creatingFolder'), cancellable: false },
      () => createFolder(client, conn.bucket, fullKey)
    );
    vscode.window.showInformationMessage(t('msg_folderCreated', folderName));
    treeProvider.refresh();
  } catch (err: any) {
    vscode.window.showErrorMessage(t('msg_folderFailed', err.message));
  }
}

function handleCopyPath(item: S3TreeItem): void {
  if (!item) return;
  vscode.env.clipboard.writeText(item.key);
  vscode.window.setStatusBarMessage(`$(link) ${t('msg_pathCopied')}`, 2000);
}

async function handleEditConnection(
  connectionManager: ConnectionManager,
  treeProvider: S3ExplorerProvider,
  item: S3TreeItem
): Promise<void> {
  if (!item || item.contextValue !== 's3Connection') {
    vscode.window.showErrorMessage(t('msg_selectFileOrFolder'));
    return;
  }

  const conn = connectionManager.getConnection(item.connectionId);
  if (!conn) { vscode.window.showErrorMessage(t('msg_connNotFound')); return; }

  const name = await vscode.window.showInputBox({
    prompt: t('prompt_edit_connectionName'),
    value: conn.name,
    validateInput: (v) => (v.trim() ? null : t('val_nameRequired')),
    ignoreFocusOut: true,
  });
  if (!name) return;

  const endpoint = await vscode.window.showInputBox({
    prompt: t('prompt_edit_endpoint'),
    value: conn.endpoint,
    validateInput: (v) => {
      if (!v.trim()) return t('val_endpointRequired');
      try { new URL(v); return null; }
      catch { return t('val_invalidUrl'); }
    },
    ignoreFocusOut: true,
  });
  if (!endpoint) return;

  const region = await vscode.window.showInputBox({
    prompt: t('prompt_edit_region'),
    value: conn.region,
    ignoreFocusOut: true,
  });
  if (!region) return;

  const bucket = await vscode.window.showInputBox({
    prompt: t('prompt_edit_bucket'),
    value: conn.bucket,
    validateInput: (v) => (v.trim() ? null : t('val_bucketRequired')),
    ignoreFocusOut: true,
  });
  if (!bucket) return;

  const pathStyleStr = await vscode.window.showQuickPick(
    [
      { label: t('prompt_pathStyle_yes'), description: t('prompt_pathStyle_yes_desc') },
      { label: t('prompt_pathStyle_no'), description: t('prompt_pathStyle_no_desc') },
    ],
    { placeHolder: t('prompt_pathStyle'), ignoreFocusOut: true }
  );
  if (!pathStyleStr) return;
  const forcePathStyle = pathStyleStr.label === t('prompt_pathStyle_yes');

  const accessKeyId = await vscode.window.showInputBox({
    prompt: t('prompt_edit_ak'),
    value: conn.accessKeyId || '',
    ignoreFocusOut: true,
  });
  if (accessKeyId === undefined) return;

  const secretAccessKey = await vscode.window.showInputBox({
    prompt: t('prompt_edit_sk'),
    password: true,
    placeHolder: conn.accessKeyId ? t('prompt_edit_sk_unchanged') : t('prompt_edit_sk_required'),
    ignoreFocusOut: true,
  });
  if (secretAccessKey === undefined) return;

  await connectionManager.updateConnection(item.connectionId, {
    name, endpoint, region, bucket, forcePathStyle,
    accessKeyId: accessKeyId || undefined,
    secretAccessKey: secretAccessKey || undefined,
  });

  const skipTest = await vscode.window.showQuickPick(
    [t('prompt_testConnection'), t('prompt_skip')],
    { placeHolder: t('prompt_testOrSkip'), ignoreFocusOut: true }
  );
  if (skipTest === t('prompt_testConnection')) {
    const updatedConn = connectionManager.getConnection(item.connectionId);
    if (updatedConn) {
      const client = createClient(updatedConn);
      const result = await testConnection(client, updatedConn.bucket);
      if (result.ok) {
        vscode.window.showInformationMessage(t('msg_verified', name));
      } else {
        vscode.window.showWarningMessage(t('msg_verifyWarn', result.error));
      }
    }
  }

  treeProvider.refresh();
}

async function handleDeleteConnection(
  connectionManager: ConnectionManager,
  treeProvider: S3ExplorerProvider,
  item: S3TreeItem
): Promise<void> {
  if (!item || item.contextValue !== 's3Connection') {
    vscode.window.showErrorMessage(t('msg_selectFileOrFolder'));
    return;
  }

  const conn = connectionManager.getConnection(item.connectionId);
  if (!conn) { vscode.window.showErrorMessage(t('msg_connNotFound')); return; }

  const confirm = await vscode.window.showWarningMessage(
    t('msg_removeConfirm', conn.name),
    t('msg_removeBtn'),
    t('msg_cancelBtn')
  );
  if (confirm !== t('msg_removeBtn')) return;

  await connectionManager.removeConnection(item.connectionId);
  vscode.window.showInformationMessage(t('msg_removedConn', conn.name));
  treeProvider.refresh();
}

async function handleSearchFiles(
  connectionManager: ConnectionManager,
  treeProvider: S3ExplorerProvider,
  item: S3TreeItem
): Promise<void> {
  if (!item || (item.contextValue !== 's3Connection' && item.contextValue !== 's3Folder')) return;

  const conn = connectionManager.getConnection(item.connectionId);
  if (!conn) { vscode.window.showErrorMessage(t('msg_connNotFound')); return; }

  const client = createClient(conn);
  const prefix = item.contextValue === 's3Folder' ? item.key : '';

  const pattern = await vscode.window.showInputBox({
    title: t('prompt_searchFiles'),
    placeHolder: t('prompt_searchFiles_placeholder'),
    ignoreFocusOut: true,
  });
  if (!pattern) return;

  const { items: objects } = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: t('msg_searching', pattern),
      cancellable: true,
    },
    () => listObjects(client, conn.bucket, prefix, 0)
  );

  const lower = pattern.toLowerCase();
  const results = objects.filter(o => o.key.toLowerCase().includes(lower));

  if (results.length === 0) {
    vscode.window.showInformationMessage(t('msg_searchNoResults'));
    return;
  }

  const qpItems = results.map(r => ({
    label: r.key.split('/').pop() || r.key,
    description: r.key,
    detail: r.size != null ? formatSize(r.size) : '',
    key: r.key,
  }));

  const pick = await vscode.window.showQuickPick(qpItems, {
    title: t('prompt_searchResults', results.length),
    matchOnDescription: true,
  });

  if (!pick) return;
  const revealed = await revealKey(treeProvider, item.connectionId, pick.key);
  if (revealed) {
    jumpHistory.addRecord(item.connectionId, pick.key, getLabel(pick.key, false), conn?.name || '');
  }
}

async function revealKey(treeProvider: S3ExplorerProvider, connectionId: string, key: string): Promise<boolean> {
  const view = S3ExplorerProvider.treeView;
  if (!view) return false;

  const normalized = key.replace(/\/$/, '');
  const segments = normalized.split('/');
  const isTargetFile = !key.endsWith('/');

  treeProvider.refresh();
  S3ExplorerProvider.pendingRevealKey = key;
  let success = false;
  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: t('msg_navigating'), cancellable: false },
      async () => {
        let currentKey = '';
        for (let i = 0; i < segments.length; i++) {
          const isLast = i === segments.length - 1;
          const isFile = isLast && isTargetFile;
          const segKey = currentKey
            ? currentKey + segments[i] + (isFile ? '' : '/')
            : segments[i] + (isFile ? '' : '/');
          const itemKey = isFile ? segKey.replace(/\/$/, '') : segKey;

          const target = new S3TreeItem(
            connectionId,
            itemKey,
            !isFile,
            segments[i],
            !isFile ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
          );

          try {
            await view.reveal(target, { select: isLast, focus: isLast, expand: !isLast });
          } catch {
            vscode.window.showErrorMessage(t('msg_pathNotFound'));
            return;
          }
          currentKey = segKey;
        }
        success = true;
      }
    );
  } finally {
    S3ExplorerProvider.pendingRevealKey = undefined;
  }
  return success;
}

function formatSize(bytes?: number): string {
  if (bytes === undefined) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = bytes;
  let unitIdx = 0;
  while (size >= 1024 && unitIdx < units.length - 1) {
    size /= 1024;
    unitIdx++;
  }
  return `${size.toFixed(1)} ${units[unitIdx]}`;
}

async function handleGetInfo(
  connectionManager: ConnectionManager,
  item: S3TreeItem
): Promise<void> {
  if (!item || item.contextValue !== 's3File') return;

  const conn = connectionManager.getConnection(item.connectionId);
  if (!conn) return;

  const client = createClient(conn);

  try {
    const detail = await getObjectDetail(client, conn.bucket, item.key);

    const qpItems: (vscode.QuickPickItem & { copyValue: string })[] = [
      { label: 'Name', description: getLabel(item.key, false), copyValue: getLabel(item.key, false) },
      { label: 'Key', description: item.key, copyValue: item.key },
      { label: 'Size', description: detail.size != null ? `${detail.size} bytes` : '-', copyValue: String(detail.size ?? '') },
      { label: 'ETag', description: detail.etag || '-', copyValue: detail.etag || '' },
      { label: 'Content-Type', description: detail.contentType || '-', copyValue: detail.contentType || '' },
      { label: 'Last-Modified', description: detail.lastModified?.toISOString() || '-', copyValue: detail.lastModified?.toISOString() || '' },
    ];

    if (detail.metadata) {
      for (const [k, v] of Object.entries(detail.metadata)) {
        qpItems.push({ label: `Meta: ${k}`, description: v, copyValue: v });
      }
    }

    if (detail.tags && detail.tags.length > 0) {
      for (const t of detail.tags) {
        qpItems.push({ label: `Tag: ${t.key}`, description: t.value, copyValue: t.value });
      }
    }

    const pick = await vscode.window.showQuickPick(qpItems, {
      title: t('prompt_objectInfo'),
      matchOnDescription: true,
      matchOnDetail: true,
    });

    if (pick) {
      vscode.env.clipboard.writeText(pick.copyValue);
      vscode.window.setStatusBarMessage(`$(copy) ${t('msg_copied')}`, 2000);
    }
  } catch (err: any) {
    vscode.window.showErrorMessage(t('msg_infoFailed', err.message));
  }
}

async function handleGoToPath(
  connectionManager: ConnectionManager,
  treeProvider: S3ExplorerProvider,
  item: S3TreeItem
): Promise<void> {
  if (!item || (item.contextValue !== 's3Connection' && item.contextValue !== 's3Folder')) return;

  const prefix = item.isFolder ? item.key : '';
  const path = await vscode.window.showInputBox({
    title: t('prompt_goToPath'),
    placeHolder: t('prompt_goToPath_placeholder'),
    value: prefix,
    ignoreFocusOut: true,
  });
  if (!path) return;

  const connId = item.connectionId;
  const normalized = path.replace(/\/$/, '');
  const segments = normalized.split('/');
  const view = S3ExplorerProvider.treeView;
  if (!view) return;

  treeProvider.refresh();
  S3ExplorerProvider.pendingRevealKey = path;
  let navigated = false;
  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: t('msg_navigating'), cancellable: false },
      async () => {
        let currentKey = '';
        for (let i = 0; i < segments.length; i++) {
          const isLast = i === segments.length - 1;
          const isFile = isLast && !path.endsWith('/');
          const segKey = currentKey ? currentKey + segments[i] + (isFile ? '' : '/') : segments[i] + (isFile ? '' : '/');
          const itemKey = isFile ? segKey.replace(/\/$/, '') : segKey;

          const target = new S3TreeItem(
            connId,
            itemKey,
            !isFile,
            segments[i],
            !isFile ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
          );

          try {
            await view.reveal(target, { select: isLast, focus: isLast, expand: !isLast });
          } catch {
            vscode.window.showErrorMessage(t('msg_pathNotFound'));
            return;
          }
          currentKey = segKey;
        }
        navigated = true;
      }
    );
  } finally {
    S3ExplorerProvider.pendingRevealKey = undefined;
  }

  if (navigated) {
    const conn = connectionManager.getConnection(connId);
    jumpHistory.addRecord(connId, path, segments[segments.length - 1], conn?.name || '');
  }
}

async function handleJumpHistory(): Promise<void> {
  JumpHistoryPanel.createOrShow(jumpHistory, async (record) => {
    const revealed = await revealKey(s3TreeProvider, record.connectionId, record.key);
    if (revealed) {
      const conn = connManager.getConnection(record.connectionId);
      jumpHistory.addRecord(record.connectionId, record.key, record.label, conn?.name || '');
    }
    JumpHistoryPanel.refresh();
  });
}

function getLabel(key: string, isFolder: boolean): string {
  const normalized = key.replace(/\/$/, '');
  const parts = normalized.split('/');
  return parts[parts.length - 1] || '/';
}
