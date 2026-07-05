import * as vscode from 'vscode';
import { ConnectionManager } from './connectionManager';
import { t } from './i18n';

export class S3TreeItem extends vscode.TreeItem {
  constructor(
    public readonly connectionId: string,
    label: string,
    public readonly connectionName: string,
    public readonly bucketName: string,
    endpoint: string
  ) {
    super(label, vscode.TreeItemCollapsibleState.None);

    this.id = connectionId;
    this.contextValue = 's3Connection';
    this.tooltip = t('tree_connTooltip', connectionName, bucketName, endpoint);
    this.description = bucketName;
    this.iconPath = new vscode.ThemeIcon('cloud');
    this.command = {
      command: 's3.openConnection',
      title: '',
      arguments: [this],
    };
  }
}

export class S3ExplorerProvider implements vscode.TreeDataProvider<S3TreeItem> {
  static connectionManager: ConnectionManager | undefined;

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

  getParent(): vscode.ProviderResult<S3TreeItem> {
    return undefined;
  }

  async getChildren(element?: S3TreeItem): Promise<S3TreeItem[]> {
    if (!element) {
      return this.getConnectionItems();
    }
    return [];
  }

  private getConnectionItems(): S3TreeItem[] {
    return this.connectionManager.connections.map((conn) =>
      new S3TreeItem(conn.id, conn.name, conn.name, conn.bucket, conn.endpoint)
    );
  }
}
