import * as vscode from 'vscode';
import { ConnectionManager } from './connectionManager';
import { createClient, listObjects, S3ObjectInfo } from './s3Client';
import { isTextFile, isImageFile, isVideoFile } from './previewManager';
import { t } from './i18n';

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

    this.id = `${connectionId}|${key}`;

    if (connectionName && bucketName && key === '') {
      this.contextValue = 's3Connection';
      this.tooltip = t('tree_connTooltip', connectionName, bucketName, this.getEndpoint());
      this.description = bucketName;
    } else if (isFolder) {
      this.contextValue = 's3Folder';
      this.tooltip = key;
      this.description = '';
      this.iconPath = vscode.ThemeIcon.Folder;
    } else {
      this.contextValue = 's3File';
      this.tooltip = t('tree_fileTooltip', key, formatSize(size), formatDate(lastModified));
      this.description = `${formatSize(size)}`;

      if (isImageFile(key) || isVideoFile(key)) {
        this.iconPath = new vscode.ThemeIcon('file-media');
      } else if (isTextFile(key)) {
        this.iconPath = new vscode.ThemeIcon('file-text');
      } else {
        this.iconPath = vscode.ThemeIcon.File;
      }


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
  private filters = new Map<string, string>();

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

  getParent(element: S3TreeItem): vscode.ProviderResult<S3TreeItem> {
    if (element.key === '') return undefined;

    const normalized = element.key.replace(/\/$/, '');
    const lastSlash = normalized.lastIndexOf('/');

    let parentKey: string;
    let isRoot = false;

    if (lastSlash === -1) {
      parentKey = '';
      isRoot = true;
    } else {
      parentKey = normalized.substring(0, lastSlash + 1);
    }

    if (isRoot) {
      const conn = this.connectionManager.getConnection(element.connectionId);
      if (!conn) return undefined;
      return new S3TreeItem(
        element.connectionId, '', true, conn.name,
        vscode.TreeItemCollapsibleState.Collapsed,
        undefined, undefined, conn.name, conn.bucket
      );
    }

    return new S3TreeItem(
      element.connectionId, parentKey, true,
      getLabel(parentKey, true),
      vscode.TreeItemCollapsibleState.Collapsed
    );
  }

  getFilterKey(element: S3TreeItem): string | undefined {
    if (element.contextValue === 's3Connection') return `conn:${element.connectionId}`;
    if (element.contextValue === 's3Folder') return `folder:${element.connectionId}|${element.key}`;
    return undefined;
  }

  getFilter(key: string): string | undefined {
    return this.filters.get(key);
  }

  setFilter(element: S3TreeItem, pattern: string): void {
    const key = this.getFilterKey(element);
    if (!key) return;
    this.filters.set(key, pattern);
    vscode.commands.executeCommand('setContext', 's3:filterActive', true);
    this.refresh(element);
  }

  clearFilter(element: S3TreeItem): void {
    const key = this.getFilterKey(element);
    if (!key) return;
    this.filters.delete(key);
    vscode.commands.executeCommand('setContext', 's3:filterActive', this.filters.size > 0);
    this.refresh(element);
  }

  clearAllFilters(): void {
    this.filters.clear();
    vscode.commands.executeCommand('setContext', 's3:filterActive', false);
    this.refresh();
  }

  async getChildren(element?: S3TreeItem): Promise<S3TreeItem[]> {
    if (!element) {
      return this.getConnectionItems();
    }

    if (element.contextValue === 's3Connection') {
      const items = await this.getObjectItems(element.connectionId, '');
      const filter = this.filters.get(`conn:${element.connectionId}`);
      if (filter) {
        const lower = filter.toLowerCase();
        return items.filter(item => item.label.toLowerCase().includes(lower));
      }
      return items;
    }

    if (element.contextValue === 's3Folder') {
      const items = await this.getObjectItems(element.connectionId, element.key);
      const filter = this.filters.get(`folder:${element.connectionId}|${element.key}`);
      if (filter) {
        const lower = filter.toLowerCase();
        return items.filter(item => item.label.toLowerCase().includes(lower));
      }
      return items;
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
