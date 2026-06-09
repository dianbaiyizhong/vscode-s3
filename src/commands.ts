import * as vscode from 'vscode';
import * as path from 'path';
import { ConnectionManager } from './connectionManager';
import { createClient, uploadFile, downloadFile, deleteObject, deleteFolder, testConnection } from './s3Client';
import { S3ExplorerProvider, S3TreeItem } from './treeView';

export function registerCommands(
  context: vscode.ExtensionContext,
  connectionManager: ConnectionManager,
  treeProvider: S3ExplorerProvider
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
    )
  );
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
  if (!item || item.contextValue !== 's3File') {
    vscode.window.showErrorMessage('Please select a file to download');
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

  const fileName = path.basename(item.key);
  const uri = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.file(fileName),
    saveLabel: 'Download',
  });
  if (!uri) return;

  const client = createClient(conn, secrets);

  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Downloading ${fileName}...`,
        cancellable: false,
      },
      () => downloadFile(client, conn.bucket, item.key, uri.fsPath)
    );
    vscode.window.showInformationMessage(`Downloaded ${fileName} successfully`);
  } catch (err: any) {
    vscode.window.showErrorMessage(`Download failed: ${err.message}`);
  }
}

async function handleDelete(
  connectionManager: ConnectionManager,
  treeProvider: S3ExplorerProvider,
  item: S3TreeItem
): Promise<void> {
  if (!item) {
    vscode.window.showErrorMessage('Please select a file or folder');
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

  const name = getLabel(item.key, item.isFolder);
  const message = item.isFolder
    ? `Delete folder "${name}" and ALL its contents?`
    : `Delete "${name}"?`;

  const confirm = await vscode.window.showWarningMessage(message, 'Delete', 'Cancel');
  if (confirm !== 'Delete') return;

  const client = createClient(conn, secrets);

  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Deleting ${name}...`,
        cancellable: false,
      },
      async () => {
        if (item.isFolder) {
          await deleteFolder(client, conn.bucket, item.key);
        } else {
          await deleteObject(client, conn.bucket, item.key);
        }
      }
    );
    vscode.window.showInformationMessage(`Deleted "${name}" successfully`);
    treeProvider.refresh();
  } catch (err: any) {
    vscode.window.showErrorMessage(`Delete failed: ${err.message}`);
  }
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
