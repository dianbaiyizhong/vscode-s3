import * as vscode from 'vscode';
import { ConnectionManager, S3Connection } from './connectionManager';
import { createClient, listObjects, S3ObjectInfo } from './s3Client';
import { isTextFile, isImageFile, isVideoFile } from './previewManager';

function getLabel(key: string, isFolder: boolean): string {
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

function formatDate(date?: Date): string {
  if (!date) return '';
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export class S3TreeItem extends vscode.TreeItem {
  constructor(
    public readonly connectionId: string,
    public readonly key: string,
    public readonly isFolder: boolean,
    label: string,
    collapsibleState: vscode.TreeItemCollapsibleState,
    size?: number,
    lastModified?: Date,
    public readonly connectionName?: string,
    public readonly bucketName?: string
  ) {
    super(label, collapsibleState);

    if (connectionName && bucketName && key === '') {
      this.contextValue = 's3Connection';
      this.tooltip = `${connectionName}\nBucket: ${bucketName}\nEndpoint: ${this.getEndpoint()}`;
      this.description = bucketName;
    } else if (isFolder) {
      this.contextValue = 's3Folder';
      this.tooltip = key;
      this.description = '';
      this.iconPath = vscode.ThemeIcon.Folder;
    } else {
      this.contextValue = 's3File';
      this.tooltip = `${key}\nSize: ${formatSize(size)}\nModified: ${formatDate(lastModified)}`;
      this.description = `${formatSize(size)}`;

      if (isImageFile(key) || isVideoFile(key)) {
        this.iconPath = new vscode.ThemeIcon('file-media');
      } else if (isTextFile(key)) {
        this.iconPath = new vscode.ThemeIcon('file-text');
      } else {
        this.iconPath = vscode.ThemeIcon.File;
      }

      this.command = {
        command: 's3.previewFile',
        title: 'Preview',
        arguments: [this],
      };
    }
  }

  private getEndpoint(): string {
    const conn = S3ExplorerProvider.connectionManager?.getConnection(this.connectionId);
    return conn?.endpoint || '';
  }
}

export class S3ExplorerProvider implements vscode.TreeDataProvider<S3TreeItem> {
  static connectionManager: ConnectionManager | undefined;
  static treeView: vscode.TreeView<S3TreeItem> | undefined;

  private _onDidChangeTreeData = new vscode.EventEmitter<S3TreeItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private connectionManager: ConnectionManager) {
    S3ExplorerProvider.connectionManager = connectionManager;
    connectionManager.onDidChange(() => this.refresh());
  }

  refresh(element?: S3TreeItem): void {
    this._onDidChangeTreeData.fire(element);
  }

  getTreeItem(element: S3TreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: S3TreeItem): Promise<S3TreeItem[]> {
    if (!element) {
      return this.getConnectionItems();
    }

    if (element.contextValue === 's3Connection' || element.contextValue === 's3Folder') {
      return this.getObjectItems(element.connectionId, element.isFolder ? element.key : '');
    }

    return [];
  }

  private getConnectionItems(): S3TreeItem[] {
    return this.connectionManager.connections.map((conn) => {
      const item = new S3TreeItem(
        conn.id,
        '',
        true,
        conn.name,
        vscode.TreeItemCollapsibleState.Collapsed,
        undefined,
        undefined,
        conn.name,
        conn.bucket
      );
      item.iconPath = new vscode.ThemeIcon('cloud');
      return item;
    });
  }

  private async getObjectItems(connectionId: string, prefix: string): Promise<S3TreeItem[]> {
    const conn = this.connectionManager.getConnection(connectionId);
    if (!conn) return [];

    const secrets = await this.connectionManager.getCredentials(connectionId);
    if (!secrets) return [];

    try {
      const client = createClient(conn, secrets);
      const objects = await listObjects(client, conn.bucket, prefix);

      return objects.map((obj) => {
        const label = getLabel(obj.key, obj.isFolder);
        const state = obj.isFolder
          ? vscode.TreeItemCollapsibleState.Collapsed
          : vscode.TreeItemCollapsibleState.None;

        return new S3TreeItem(
          connectionId,
          obj.key,
          obj.isFolder,
          label,
          state,
          obj.size,
          obj.lastModified
        );
      });
    } catch (err: any) {
      const msg = err.message || String(err);
      const item = new S3TreeItem(
        connectionId,
        '',
        false,
        `Error: ${msg}`,
        vscode.TreeItemCollapsibleState.None
      );
      item.contextValue = '';
      item.iconPath = new vscode.ThemeIcon('error');
      return [item];
    }
  }
}
