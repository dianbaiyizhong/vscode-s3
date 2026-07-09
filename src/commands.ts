import * as vscode from 'vscode';
import { ConnectionManager } from './connectionManager';
import { S3ExplorerProvider, S3TreeItem } from './treeView';
import { t } from './i18n';
import { JumpHistory } from './jumpHistory';
import { FolderBrowserPanel } from './folderBrowserPanel';
import { SettingsPanel } from './settingsPanel';
import { createClient, getBucketInfo } from './s3Client';

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
    vscode.commands.registerCommand('s3.openSettings', () =>
      SettingsPanel.createOrShow(connectionManager)
    ),
    vscode.commands.registerCommand('s3.addConnection', () =>
      SettingsPanel.createOrShow(connectionManager)
    ),
    vscode.commands.registerCommand('s3.refresh', (item?: S3TreeItem) =>
      treeProvider.refresh(item)
    ),
    vscode.commands.registerCommand('s3.editConnection', (item: S3TreeItem) =>
      SettingsPanel.createOrShow(connectionManager)
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
    vscode.commands.registerCommand('s3.bucketInfo', (item: S3TreeItem) =>
      handleBucketInfo(item)
    )
  );
}

function handleOpenConnection(item: S3TreeItem): void {
  if (!item || item.contextValue !== 's3Connection') return;
  const conn = connManager.getConnection(item.connectionId);
  if (!conn) return;
  FolderBrowserPanel.create(
    connManager, item.connectionId, '', conn.name,
    (id, prefix) => { jumpHistory.addRecord(id, prefix, getLabel(prefix, true), conn.name); },
    () => jumpHistory.getRecords()
  );
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
    t('msg_removeConfirm', conn.name),
    { modal: true },
    t('msg_removeBtn')
  );
  if (confirmed !== t('msg_removeBtn')) return;
  await connectionManager.removeConnection(item.connectionId);
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
  const panel = FolderBrowserPanel.create(
    connManager, item.connectionId, prefix, segments[segments.length - 1],
    (id, p) => { jumpHistory.addRecord(id, p, getLabel(p, true), conn.name); },
    () => jumpHistory.getRecords()
  );
  if (!isDir) {
    await panel.goToPath(targetPath);
  }
}

async function handleBucketInfo(item: S3TreeItem): Promise<void> {
  if (!item || item.contextValue !== 's3Connection') return;
  const conn = connManager.getConnection(item.connectionId);
  if (!conn) return;
  const client = createClient(conn);
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: t('msg_gatheringBucketInfo') },
    async () => {
      try {
        const info = await getBucketInfo(client, conn.bucket);
        const items: { label: string; value: string }[] = [
          { label: t('msg_bucket'), value: conn.bucket },
          { label: t('msg_totalObjects'), value: info.totalObjects >= 200000 ? '200000+' : String(info.totalObjects) },
          { label: t('msg_totalSize'), value: formatSize(info.totalSize) },
          { label: t('msg_connection'), value: conn.name },
          { label: t('msg_endpoint'), value: conn.endpoint },
        ];
        const picks = items.map(i => ({ label: i.label, description: i.value }));
        const pick = await vscode.window.showQuickPick(picks, {
          title: t('msg_bucketInfoTitle', conn.bucket),
          placeHolder: t('msg_bucketInfoPlaceholder'),
          matchOnDescription: true,
        });
        if (pick) {
          vscode.env.clipboard.writeText(pick.description || '');
          vscode.window.setStatusBarMessage(`$(link) ${t('msg_copied', pick.description)}`, 2000);
        }
      } catch (err: any) {
        vscode.window.showErrorMessage(`Failed to get bucket info: ${err.message}`);
      }
    }
  );
}

function getParentPrefix(key: string): string {
  const normalized = key.replace(/\/$/, '');
  const lastSlash = normalized.lastIndexOf('/');
  if (lastSlash === -1) return '';
  return normalized.substring(0, lastSlash + 1);
}

function getLabel(key: string, _isFolder: boolean): string {
  const normalized = key.replace(/\/$/, '');
  const segments = normalized.split('/');
  return segments[segments.length - 1] || '/';
}

function formatSize(bytes?: number): string {
  if (bytes == null) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
