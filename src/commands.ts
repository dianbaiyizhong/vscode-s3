import * as vscode from 'vscode';
import { ConnectionManager } from './connectionManager';
import { createClient, testConnection } from './s3Client';
import { S3ExplorerProvider, S3TreeItem } from './treeView';
import { t } from './i18n';
import { JumpHistory } from './jumpHistory';
import { JumpHistoryPanel } from './jumpHistoryPanel';
import { FolderBrowserPanel } from './folderBrowserPanel';

let jumpHistory: JumpHistory;
let connManager: ConnectionManager;

export function registerCommands(
  context: vscode.ExtensionContext,
  connectionManager: ConnectionManager,
  treeProvider: S3ExplorerProvider,
  history: JumpHistory
): void {
  jumpHistory = history;
  connManager = connectionManager;

  context.subscriptions.push(
    vscode.commands.registerCommand('s3.addConnection', () =>
      addConnection(connectionManager, treeProvider)
    ),
    vscode.commands.registerCommand('s3.refresh', (item?: S3TreeItem) =>
      treeProvider.refresh(item)
    ),
    vscode.commands.registerCommand('s3.editConnection', (item: S3TreeItem) =>
      editConnection(connectionManager, treeProvider, item)
    ),
    vscode.commands.registerCommand('s3.deleteConnection', (item: S3TreeItem) =>
      deleteConnection(connectionManager, treeProvider, item)
    ),
    vscode.commands.registerCommand('s3.openConnection', (item: S3TreeItem) =>
      handleOpenConnection(item)
    ),
    vscode.commands.registerCommand('s3.goToPath', (item: S3TreeItem) =>
      handleGoToPath(connectionManager, item)
    ),
    vscode.commands.registerCommand('s3.jumpHistory', () =>
      handleJumpHistory()
    )
  );
}

function handleOpenConnection(item: S3TreeItem): void {
  if (!item || item.contextValue !== 's3Connection') return;
  const conn = connManager.getConnection(item.connectionId);
  if (!conn) return;
  FolderBrowserPanel.create(connManager, item.connectionId, '', conn.name, (id, prefix) => {
    jumpHistory.addRecord(id, prefix, getLabel(prefix, true), conn.name);
  });
}

async function addConnection(
  connectionManager: ConnectionManager,
  treeProvider: S3ExplorerProvider
): Promise<void> {
  const name = await vscode.window.showInputBox({
    title: t('prompt_connName'),
    placeHolder: t('prompt_connName_placeholder'),
    ignoreFocusOut: true,
  });
  if (!name) return;

  const endpoint = await vscode.window.showInputBox({
    title: t('prompt_endpoint'),
    placeHolder: t('prompt_endpoint_placeholder'),
    value: 'https://',
    ignoreFocusOut: true,
  });
  if (!endpoint) return;

  const region = (await vscode.window.showInputBox({
    title: t('prompt_region'),
    value: 'us-east-1',
    ignoreFocusOut: true,
  })) || 'us-east-1';

  const bucket = await vscode.window.showInputBox({
    title: t('prompt_bucket'),
    placeHolder: t('prompt_bucket_placeholder'),
    ignoreFocusOut: true,
  });
  if (!bucket) return;

  const forcePathStyle = (await vscode.window.showQuickPick(
    [
      { label: t('opt_yes'), description: t('opt_yes_desc') },
      { label: t('opt_no'), description: t('opt_no_desc') },
    ],
    { title: t('prompt_forcePathStyle') }
  ))?.label;
  if (!forcePathStyle) return;

  const accessKeyId = await vscode.window.showInputBox({
    title: t('prompt_accessKey'),
    placeHolder: t('prompt_accessKey_placeholder'),
    ignoreFocusOut: true,
  });
  if (!accessKeyId) return;

  const secretAccessKey = await vscode.window.showInputBox({
    title: t('prompt_secretKey'),
    placeHolder: t('prompt_secretKey_placeholder'),
    password: true,
    ignoreFocusOut: true,
  });
  if (!secretAccessKey) return;

  const conn = {
    name,
    endpoint,
    region,
    bucket,
    forcePathStyle: forcePathStyle === t('opt_yes'),
    accessKeyId,
    secretAccessKey,
  };

  const testClient = createClient(conn);
  const loading = vscode.window.setStatusBarMessage('$(sync~spin) Testing connection...');
  const testResult = await testConnection(testClient, conn.bucket);
  loading.dispose();

  if (!testResult.ok) {
    vscode.window.showErrorMessage(t('msg_connectionFailed', testResult.error));
    return;
  }

  connectionManager.addConnection(conn);
  treeProvider.refresh();
  vscode.window.showInformationMessage(t('msg_connectionSuccess'));
}

async function editConnection(
  connectionManager: ConnectionManager,
  treeProvider: S3ExplorerProvider,
  item: S3TreeItem
): Promise<void> {
  if (!item || item.contextValue !== 's3Connection') return;
  const conn = connectionManager.getConnection(item.connectionId);
  if (!conn) return;

  const name = await vscode.window.showInputBox({
    title: t('prompt_connName'),
    value: conn.name,
    ignoreFocusOut: true,
  });
  if (!name) return;

  const endpoint = await vscode.window.showInputBox({
    title: t('prompt_endpoint'),
    value: conn.endpoint,
    ignoreFocusOut: true,
  });
  if (!endpoint) return;

  const region = (await vscode.window.showInputBox({
    title: t('prompt_region'),
    value: conn.region,
    ignoreFocusOut: true,
  })) || 'us-east-1';

  const bucket = await vscode.window.showInputBox({
    title: t('prompt_bucket'),
    value: conn.bucket,
    ignoreFocusOut: true,
  });
  if (!bucket) return;

  const forcePathLabel = conn.forcePathStyle ? t('opt_yes') : t('opt_no');
  const forcePathStyle = (await vscode.window.showQuickPick(
    [
      { label: t('opt_yes'), description: t('opt_yes_desc') },
      { label: t('opt_no'), description: t('opt_no_desc') },
    ],
    { title: t('prompt_forcePathStyle'), value: forcePathLabel }
  ))?.label;
  if (!forcePathStyle) return;

  const accessKeyId = await vscode.window.showInputBox({
    title: t('prompt_accessKey'),
    value: conn.accessKeyId,
    ignoreFocusOut: true,
  });
  if (!accessKeyId) return;

  const secretAccessKey = await vscode.window.showInputBox({
    title: t('prompt_secretKey'),
    value: conn.secretAccessKey,
    password: true,
    ignoreFocusOut: true,
  });
  if (!secretAccessKey) return;

  connectionManager.updateConnection(item.connectionId, {
    name,
    endpoint,
    region,
    bucket,
    forcePathStyle: forcePathStyle === t('opt_yes'),
    accessKeyId,
    secretAccessKey,
  });
  treeProvider.refresh();
}

async function deleteConnection(
  connectionManager: ConnectionManager,
  treeProvider: S3ExplorerProvider,
  item: S3TreeItem
): Promise<void> {
  if (!item || item.contextValue !== 's3Connection') return;
  const conn = connectionManager.getConnection(item.connectionId);
  if (!conn) return;

  const confirmed = await vscode.window.showWarningMessage(
    t('msg_confirmDeleteConn', conn.name),
    { modal: true },
    t('opt_delete')
  );
  if (confirmed !== t('opt_delete')) return;

  connectionManager.removeConnection(item.connectionId);
  treeProvider.refresh();
}

async function handleGoToPath(
  connectionManager: ConnectionManager,
  item: S3TreeItem
): Promise<void> {
  if (!item || item.contextValue !== 's3Connection') return;
  const conn = connectionManager.getConnection(item.connectionId);
  if (!conn) return;

  const targetPath = await vscode.window.showInputBox({
    title: t('prompt_goToPath'),
    placeHolder: t('prompt_goToPath_placeholder'),
    ignoreFocusOut: true,
  });
  if (!targetPath) return;

  const isDir = targetPath.endsWith('/');
  const segments = targetPath.replace(/\/$/, '').split('/');
  const prefix = isDir ? targetPath : getParentPrefix(targetPath);

  jumpHistory.addRecord(item.connectionId, targetPath, segments[segments.length - 1], conn.name);
  const panel = FolderBrowserPanel.create(connManager, item.connectionId, prefix, segments[segments.length - 1], (id, p) => {
    jumpHistory.addRecord(id, p, getLabel(p, true), conn.name);
  });
  if (!isDir) {
    await panel.goToPath(targetPath);
  }
}

async function handleJumpHistory(): Promise<void> {
  JumpHistoryPanel.createOrShow(jumpHistory, async (record) => {
    const conn = connManager.getConnection(record.connectionId);
    if (!conn) return;
    const prefix = record.key.endsWith('/') ? record.key : getParentPrefix(record.key);
    const panel = FolderBrowserPanel.create(connManager, record.connectionId, prefix, getLabel(record.key, true), (id, p) => {
      jumpHistory.addRecord(id, p, getLabel(p, true), conn.name);
    }, true);
    if (!record.key.endsWith('/')) {
      await panel.goToPath(record.key);
    }
  });
}

function getParentPrefix(key: string): string {
  const normalized = key.replace(/\/$/, '');
  const lastSlash = normalized.lastIndexOf('/');
  if (lastSlash === -1) return '';
  return normalized.substring(0, lastSlash + 1);
}

function getLabel(key: string, _isFolder: boolean): string {
  const normalized = key.replace(/\/$/, '');
  const parts = normalized.split('/');
  return parts[parts.length - 1] || '/';
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
