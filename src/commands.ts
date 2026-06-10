import * as vscode from 'vscode';
import * as path from 'path';
import { ConnectionManager } from './connectionManager';
import { createClient, uploadFile, downloadFile, deleteObject, deleteFolder, renameObject, renameFolder, createFolder, testConnection } from './s3Client';
import { S3ExplorerProvider, S3TreeItem } from './treeView';
import { PreviewManager, isTextFile, isImageFile, isPreviewable } from './previewManager';

export function registerCommands(
  context: vscode.ExtensionContext,
  connectionManager: ConnectionManager,
  treeProvider: S3ExplorerProvider,
  previewManager: PreviewManager
): void {
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
    prompt: 'Connection name (e.g., My MinIO)',
    placeHolder: 'My S3 Storage',
    validateInput: (v) => (v.trim() ? null : 'Name is required'),
    ignoreFocusOut: true,
  });
  if (!name) return;

  const endpoint = await vscode.window.showInputBox({
    prompt: 'S3 Endpoint URL',
    placeHolder: 'https://s3.example.com',
    validateInput: (v) => {
      if (!v.trim()) return 'Endpoint is required';
      try {
        new URL(v);
        return null;
      } catch {
        return 'Invalid URL';
      }
    },
    ignoreFocusOut: true,
  });
  if (!endpoint) return;

  const region = await vscode.window.showInputBox({
    prompt: 'Region (default: us-east-1)',
    placeHolder: 'us-east-1',
    value: 'us-east-1',
    ignoreFocusOut: true,
  });
  if (!region) return;

  const bucket = await vscode.window.showInputBox({
    prompt: 'Bucket name',
    placeHolder: 'my-bucket',
    validateInput: (v) => (v.trim() ? null : 'Bucket name is required'),
    ignoreFocusOut: true,
  });
  if (!bucket) return;

  const pathStyleStr = await vscode.window.showQuickPick(
    [
      { label: 'Yes', description: 'Use path-style URLs (e.g., http://host/bucket/key) - common for MinIO, Ceph, etc.' },
      { label: 'No', description: 'Use virtual-hosted-style URLs (e.g., http://bucket.host/key) - standard AWS S3' },
    ],
    {
      placeHolder: 'Use path-style endpoint?',
      ignoreFocusOut: true,
    }
  );
  if (!pathStyleStr) return;
  const forcePathStyle = pathStyleStr.label === 'Yes';

  const accessKeyId = await vscode.window.showInputBox({
    prompt: 'Access Key ID',
    placeHolder: 'AKIAIOSFODNN7EXAMPLE',
    validateInput: (v) => (v.trim() ? null : 'Access Key ID is required'),
    ignoreFocusOut: true,
  });
  if (!accessKeyId) return;

  const secretAccessKey = await vscode.window.showInputBox({
    prompt: 'Secret Access Key',
    placeHolder: 'xxxxxxxxxxxxxxxxxxxxxxxxx',
    password: true,
    validateInput: (v) => (v.trim() ? null : 'Secret Access Key is required'),
    ignoreFocusOut: true,
  });
  if (!secretAccessKey) return;

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'Testing connection...',
      cancellable: false,
    },
    async () => {
      const conn = await connectionManager.addConnection({
        name,
        endpoint,
        region,
        bucket,
        forcePathStyle,
        accessKeyId,
        secretAccessKey,
      });

      const secrets = await connectionManager.getCredentials(conn.id);
      if (!secrets) {
        vscode.window.showErrorMessage('Failed to store credentials');
        return;
      }

      const client = createClient(conn, secrets);
      const result = await testConnection(client, bucket);

      if (result.ok) {
        vscode.window.showInformationMessage(`Connected to "${name}" successfully`);
        treeProvider.refresh();
      } else {
        const action = await vscode.window.showErrorMessage(
          `Connection failed: ${result.error}`,
          'Remove Connection',
          'Keep Anyway'
        );
        if (action === 'Remove Connection') {
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
    vscode.window.showErrorMessage('Please select a folder or connection first');
    return;
  }

  const conn = connectionManager.getConnection(item.connectionId);
  if (!conn) {
    vscode.window.showErrorMessage('Connection not found');
    return;
  }

  const secrets = await connectionManager.getCredentials(item.connectionId);
  if (!secrets) {
    vscode.window.showErrorMessage('Credentials not found');
    return;
  }

  const fileUris = await vscode.window.showOpenDialog({
    canSelectFiles: true,
    canSelectMany: true,
    openLabel: 'Upload',
  });
  if (!fileUris || fileUris.length === 0) return;

  const client = createClient(conn, secrets);
  const prefix = item.isFolder ? item.key : '';

  for (const fileUri of fileUris) {
    const filePath = fileUri.fsPath;
    const fileName = path.basename(filePath);
    const key = prefix + fileName;

    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Uploading ${fileName}...`,
          cancellable: false,
        },
        () => uploadFile(client, conn.bucket, key, filePath)
      );
    } catch (err: any) {
      vscode.window.showErrorMessage(`Failed to upload ${fileName}: ${err.message}`);
      return;
    }
  }

  vscode.window.showInformationMessage(`Uploaded ${fileUris.length} file(s) successfully`);
}

async function handleDownload(
  connectionManager: ConnectionManager,
  item: S3TreeItem
): Promise<void> {
  const items = getSelectionOrDefault(item, 's3File');
  if (items.length === 0) {
    vscode.window.showErrorMessage('Please select a file to download');
    return;
  }

  const files = items.filter(i => i.contextValue === 's3File');
  if (files.length === 0) {
    vscode.window.showErrorMessage('Please select a file to download');
    return;
  }

  const conn = connectionManager.getConnection(files[0].connectionId);
  if (!conn) { vscode.window.showErrorMessage('Connection not found'); return; }

  const secrets = await connectionManager.getCredentials(files[0].connectionId);
  if (!secrets) { vscode.window.showErrorMessage('Credentials not found'); return; }

  const client = createClient(conn, secrets);

  if (files.length === 1) {
    const fileName = path.basename(files[0].key);
    const uri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(fileName),
      saveLabel: 'Download',
    });
    if (!uri) return;
    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Downloading ${fileName}...`, cancellable: false },
        () => downloadFile(client, conn.bucket, files[0].key, uri.fsPath)
      );
      vscode.window.showInformationMessage(`Downloaded ${fileName}`);
    } catch (err: any) {
      vscode.window.showErrorMessage(`Download failed: ${err.message}`);
    }
    return;
  }

  const dirUri = await vscode.window.showOpenDialog({
    canSelectFolders: true,
    canSelectFiles: false,
    openLabel: 'Download All Here',
  });
  if (!dirUri) return;
  const baseDir = dirUri[0].fsPath;

  let successCount = 0;
  let failCount = 0;

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Downloading ${files.length} files...`, cancellable: false },
    async () => {
      for (const f of files) {
        const localPath = path.join(baseDir, path.basename(f.key));
        try {
          await downloadFile(client, conn.bucket, f.key, localPath);
          successCount++;
        } catch {
          failCount++;
        }
      }
    }
  );

  if (failCount === 0) {
    vscode.window.showInformationMessage(`Downloaded ${successCount} file(s) to ${baseDir}`);
  } else {
    vscode.window.showWarningMessage(`Downloaded ${successCount} file(s), ${failCount} failed`);
  }
}

async function handleDelete(
  connectionManager: ConnectionManager,
  treeProvider: S3ExplorerProvider,
  item: S3TreeItem
): Promise<void> {
  const items = getSelectionOrDefault(item, 's3File', 's3Folder');
  if (items.length === 0) {
    vscode.window.showErrorMessage('Please select a file or folder');
    return;
  }

  const conn = connectionManager.getConnection(items[0].connectionId);
  if (!conn) { vscode.window.showErrorMessage('Connection not found'); return; }

  const secrets = await connectionManager.getCredentials(items[0].connectionId);
  if (!secrets) { vscode.window.showErrorMessage('Credentials not found'); return; }

  const client = createClient(conn, secrets);

  const confirmMsg = items.length === 1
    ? items[0].isFolder
      ? `Delete folder "${getLabel(items[0].key, true)}" and ALL its contents?`
      : `Delete "${getLabel(items[0].key, false)}"?`
    : `Delete ${items.length} selected item(s)?`;

  const confirm = await vscode.window.showWarningMessage(confirmMsg, 'Delete', 'Cancel');
  if (confirm !== 'Delete') return;

  let successCount = 0;
  let failCount = 0;

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Deleting ${items.length} item(s)...`, cancellable: false },
    async () => {
      for (const target of items) {
        try {
          if (target.isFolder) {
            await deleteFolder(client, conn.bucket, target.key);
          } else {
            await deleteObject(client, conn.bucket, target.key);
          }
          successCount++;
        } catch {
          failCount++;
        }
      }
    }
  );

  treeProvider.refresh();

  if (failCount === 0) {
    vscode.window.showInformationMessage(`Deleted ${successCount} item(s) successfully`);
  } else {
    vscode.window.showWarningMessage(`Deleted ${successCount} item(s), ${failCount} failed`);
  }
}

async function handlePreviewFile(
  connectionManager: ConnectionManager,
  previewManager: PreviewManager,
  item: S3TreeItem
): Promise<void> {
  if (!item || item.contextValue !== 's3File') return;

  const conn = connectionManager.getConnection(item.connectionId);
  const secrets = await connectionManager.getCredentials(item.connectionId);
  if (!conn || !secrets) return;

  if (!isPreviewable(item.key)) {
    vscode.window.showInformationMessage('Preview not supported for this file type');
    return;
  }

  const localPath = previewManager.getTempPath(item.connectionId, item.key);
  previewManager.ensureParentDir(localPath);

  const client = createClient(conn, secrets);

  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: 'Opening file...', cancellable: false },
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
    vscode.window.showErrorMessage(`Failed to open file: ${err.message}`);
  }
}

async function handleRename(
  connectionManager: ConnectionManager,
  treeProvider: S3ExplorerProvider,
  item: S3TreeItem
): Promise<void> {
  if (!item || (item.contextValue !== 's3File' && item.contextValue !== 's3Folder')) {
    vscode.window.showErrorMessage('Please select a file or folder');
    return;
  }

  const conn = connectionManager.getConnection(item.connectionId);
  const secrets = await connectionManager.getCredentials(item.connectionId);
  if (!conn || !secrets) { vscode.window.showErrorMessage('Connection not found'); return; }

  const client = createClient(conn, secrets);
  const oldName = getLabel(item.key, item.isFolder);
  const prefix = item.isFolder
    ? item.key.slice(0, item.key.length - oldName.length)
    : item.key.slice(0, item.key.length - oldName.length - (item.key.endsWith('/') ? 1 : 0));
  const prefixPath = item.isFolder ? item.key.slice(0, -oldName.length) : item.key.slice(0, -oldName.length);

  const newName = await vscode.window.showInputBox({
    prompt: item.isFolder ? 'New folder name' : 'New file name',
    value: oldName,
    validateInput: (v) => (v.trim() ? null : 'Name is required'),
    ignoreFocusOut: true,
  });
  if (!newName || newName === oldName) return;

  const oldKey = item.key;
  const newKey = item.isFolder ? prefixPath + newName + '/' : prefixPath + newName;

  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Renaming...`, cancellable: false },
      async () => {
        if (item.isFolder) {
          await renameFolder(client, conn.bucket, oldKey, newKey);
        } else {
          await renameObject(client, conn.bucket, oldKey, newKey);
        }
      }
    );
    vscode.window.showInformationMessage(`Renamed to "${newName}"`);
    treeProvider.refresh();
  } catch (err: any) {
    vscode.window.showErrorMessage(`Rename failed: ${err.message}`);
  }
}

async function handleNewFolder(
  connectionManager: ConnectionManager,
  treeProvider: S3ExplorerProvider,
  item: S3TreeItem
): Promise<void> {
  if (!item || (item.contextValue !== 's3Connection' && item.contextValue !== 's3Folder')) {
    vscode.window.showErrorMessage('Please select a connection or folder');
    return;
  }

  const conn = connectionManager.getConnection(item.connectionId);
  const secrets = await connectionManager.getCredentials(item.connectionId);
  if (!conn || !secrets) { vscode.window.showErrorMessage('Connection not found'); return; }

  const client = createClient(conn, secrets);
  const parentPrefix = item.contextValue === 's3Folder' ? item.key : '';

  const folderName = await vscode.window.showInputBox({
    prompt: 'New folder name',
    placeHolder: 'my-folder',
    validateInput: (v) => (v.trim() ? null : 'Folder name is required'),
    ignoreFocusOut: true,
  });
  if (!folderName) return;

  const fullKey = parentPrefix + folderName;

  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Creating folder...', cancellable: false },
      () => createFolder(client, conn.bucket, fullKey)
    );
    vscode.window.showInformationMessage(`Created folder "${folderName}"`);
    treeProvider.refresh();
  } catch (err: any) {
    vscode.window.showErrorMessage(`Create folder failed: ${err.message}`);
  }
}

function handleCopyPath(item: S3TreeItem): void {
  if (!item) return;
  vscode.env.clipboard.writeText(item.key);
  vscode.window.setStatusBarMessage('$(link) Path copied', 2000);
}

async function handleEditConnection(
  connectionManager: ConnectionManager,
  treeProvider: S3ExplorerProvider,
  item: S3TreeItem
): Promise<void> {
  if (!item || item.contextValue !== 's3Connection') {
    vscode.window.showErrorMessage('Please select a connection');
    return;
  }

  const conn = connectionManager.getConnection(item.connectionId);
  if (!conn) {
    vscode.window.showErrorMessage('Connection not found');
    return;
  }

  const currentSecrets = await connectionManager.getCredentials(item.connectionId);

  const name = await vscode.window.showInputBox({
    prompt: 'Connection name',
    value: conn.name,
    validateInput: (v) => (v.trim() ? null : 'Name is required'),
    ignoreFocusOut: true,
  });
  if (!name) return;

  const endpoint = await vscode.window.showInputBox({
    prompt: 'S3 Endpoint URL',
    value: conn.endpoint,
    validateInput: (v) => {
      if (!v.trim()) return 'Endpoint is required';
      try { new URL(v); return null; }
      catch { return 'Invalid URL'; }
    },
    ignoreFocusOut: true,
  });
  if (!endpoint) return;

  const region = await vscode.window.showInputBox({
    prompt: 'Region',
    value: conn.region,
    ignoreFocusOut: true,
  });
  if (!region) return;

  const bucket = await vscode.window.showInputBox({
    prompt: 'Bucket name',
    value: conn.bucket,
    validateInput: (v) => (v.trim() ? null : 'Bucket name is required'),
    ignoreFocusOut: true,
  });
  if (!bucket) return;

  const pathStyleStr = await vscode.window.showQuickPick(
    [
      { label: 'Yes', description: 'Path-style (e.g., http://host/bucket/key)' },
      { label: 'No', description: 'Virtual-hosted-style (e.g., http://bucket.host/key)' },
    ],
    {
      placeHolder: 'Use path-style endpoint?',
      ignoreFocusOut: true,
    }
  );
  if (!pathStyleStr) return;
  const forcePathStyle = pathStyleStr.label === 'Yes';

  const accessKeyId = await vscode.window.showInputBox({
    prompt: 'Access Key ID (leave blank to keep current)',
    value: currentSecrets?.accessKeyId || '',
    ignoreFocusOut: true,
  });
  if (accessKeyId === undefined) return;

  const secretAccessKey = await vscode.window.showInputBox({
    prompt: 'Secret Access Key (leave blank to keep current)',
    password: true,
    placeHolder: currentSecrets ? '(unchanged if left blank)' : 'Required',
    ignoreFocusOut: true,
  });
  if (secretAccessKey === undefined) return;

  await connectionManager.updateConnection(item.connectionId, {
    name,
    endpoint,
    region,
    bucket,
    forcePathStyle,
    accessKeyId: accessKeyId || undefined,
    secretAccessKey: secretAccessKey || undefined,
  });

  const skipTest = await vscode.window.showQuickPick(
    ['Test Connection', 'Skip'],
    { placeHolder: 'Connection updated. Test it now?', ignoreFocusOut: true }
  );
  if (skipTest === 'Test Connection') {
    const updatedConn = connectionManager.getConnection(item.connectionId);
    const secrets = await connectionManager.getCredentials(item.connectionId);
    if (updatedConn && secrets) {
      const client = createClient(updatedConn, secrets);
      const result = await testConnection(client, updatedConn.bucket);
      if (result.ok) {
        vscode.window.showInformationMessage(`Connection "${name}" verified successfully`);
      } else {
        vscode.window.showWarningMessage(`Connection test failed: ${result.error}`);
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
    vscode.window.showErrorMessage('Please select a connection');
    return;
  }

  const conn = connectionManager.getConnection(item.connectionId);
  if (!conn) {
    vscode.window.showErrorMessage('Connection not found');
    return;
  }

  const confirm = await vscode.window.showWarningMessage(
    `Remove connection "${conn.name}"?`,
    'Remove',
    'Cancel'
  );
  if (confirm !== 'Remove') return;

  await connectionManager.removeConnection(item.connectionId);
  vscode.window.showInformationMessage(`Removed connection "${conn.name}"`);
  treeProvider.refresh();
}

function getLabel(key: string, isFolder: boolean): string {
  const normalized = key.replace(/\/$/, '');
  const parts = normalized.split('/');
  return parts[parts.length - 1] || '/';
}
