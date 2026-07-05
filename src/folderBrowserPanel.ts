import * as vscode from 'vscode';
import { createClient, listObjects, S3ObjectInfo } from './s3Client';
import { S3Connection } from './connectionManager';

export class FolderBrowserPanel {
  public static currentPanel: FolderBrowserPanel | undefined;

  public static createOrShow(
    connection: S3Connection,
    connectionId: string,
    prefix: string,
    label: string,
    onNavigate: (connectionId: string, prefix: string) => void
  ): void {
    const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;

    if (FolderBrowserPanel.currentPanel) {
      const sameTarget = FolderBrowserPanel.currentPanel.connectionId === connectionId
        && FolderBrowserPanel.currentPanel.prefix === prefix;
      if (sameTarget) {
        FolderBrowserPanel.currentPanel.panel.reveal(column);
        return;
      }
      FolderBrowserPanel.currentPanel.panel.dispose();
    }

    FolderBrowserPanel.currentPanel = new FolderBrowserPanel(
      column, connection, connectionId, prefix, label, onNavigate
    );
  }

  private panel: vscode.WebviewPanel;
  private connectionId: string;
  private prefix: string;
  private bucket: string;
  private items: S3ObjectInfo[] = [];
  private nextToken?: string;
  private loading = false;

  private constructor(
    column: vscode.ViewColumn,
    connection: S3Connection,
    connectionId: string,
    prefix: string,
    label: string,
    private onNavigate: (connectionId: string, prefix: string) => void
  ) {
    this.connectionId = connectionId;
    this.prefix = prefix;
    this.bucket = connection.bucket;

    const displayPath = prefix ? prefix.replace(/\/$/, '') : '/';
    this.panel = vscode.window.createWebviewPanel(
      'folderBrowser',
      `${label} — ${connection.name}`,
      column,
      { enableScripts: true }
    );

    this.loadItems().then(() => this.render());

    this.panel.onDidDispose(() => {
      FolderBrowserPanel.currentPanel = undefined;
    });

    this.panel.webview.onDidReceiveMessage(async message => {
      switch (message.type) {
        case 'loadMore':
          await this.loadItems();
          this.render();
          break;
        case 'navigate':
          this.prefix = message.prefix;
          this.items = [];
          this.nextToken = undefined;
          this.render();
          await this.loadItems();
          this.render();
          this.onNavigate(this.connectionId, message.prefix);
          break;
        case 'navigateUp': {
          const parent = this.getParentPrefix();
          this.prefix = parent;
          this.items = [];
          this.nextToken = undefined;
          this.render();
          await this.loadItems();
          this.render();
          this.onNavigate(this.connectionId, parent);
          break;
        }
      }
    });
  }

  private getParentPrefix(): string {
    if (!this.prefix) return '';
    const trimmed = this.prefix.replace(/\/$/, '');
    const parts = trimmed.split('/');
    parts.pop();
    return parts.length > 0 ? parts.join('/') + '/' : '';
  }

  private async loadItems(): Promise<void> {
    if (this.loading) return;
    this.loading = true;
    try {
      const connectionManager = getConnectionManager();
      const conn = connectionManager.getConnection(this.connectionId);
      if (!conn) return;

      const client = createClient(conn);
      const result = await listObjects(client, conn.bucket, this.prefix, 1, undefined, this.nextToken);
      this.items.push(...result.items);
      this.nextToken = result.nextToken;
    } finally {
      this.loading = false;
    }
  }

  private render(): void {
    this.panel.title = `${this.prefix || '/'} (${this.items.length})`;
    this.panel.webview.html = getHtml(
      this.prefix,
      this.items,
      !!this.nextToken,
      this.loading
    );
  }
}

let _connManager: import('./connectionManager').ConnectionManager;

export function setConnectionManager(cm: import('./connectionManager').ConnectionManager): void {
  _connManager = cm;
}

function getConnectionManager(): import('./connectionManager').ConnectionManager {
  return _connManager;
}

function formatSize(bytes?: number): string {
  if (bytes == null) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(date?: Date): string {
  if (!date) return '';
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function getHtml(prefix: string, items: S3ObjectInfo[], hasMore: boolean, loading: boolean): string {
  const folderRows = items.filter(i => i.isFolder).map(i => {
    const name = i.key.replace(/\/$/, '').split('/').pop() || '';
    return `<div class="item folder" data-prefix="${escapeHtml(i.key)}" data-label="${escapeHtml(name)}">
      <span class="item-icon">&#x1F4C1;</span>
      <span class="item-name">${escapeHtml(name)}</span>
      <span class="item-meta"></span>
    </div>`;
  }).join('');

  const fileRows = items.filter(i => !i.isFolder).map(i => {
    const name = i.key.split('/').pop() || i.key;
    return `<div class="item file">
      <span class="item-icon">&#x1F4C4;</span>
      <span class="item-name">${escapeHtml(name)}</span>
      <span class="item-meta">${formatSize(i.size)} · ${formatDate(i.lastModified)}</span>
    </div>`;
  }).join('');

  const allRows = folderRows + fileRows;

  const loadMoreBtn = hasMore
    ? `<button class="load-more" id="loadMoreBtn" ${loading ? 'disabled' : ''}>
        ${loading ? 'Loading...' : 'Load More'}
       </button>`
    : '';

  const emptyState = !allRows && !loading
    ? '<div class="empty">This folder is empty</div>'
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
body {
  margin: 0;
  padding: 16px;
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size);
  color: var(--vscode-foreground);
  background: var(--vscode-editor-background);
}
.header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 16px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--vscode-panel-border);
}
.back-btn {
  background: none;
  border: none;
  color: var(--vscode-textLink-foreground);
  cursor: pointer;
  font-size: 18px;
  padding: 2px 6px;
  border-radius: 4px;
  line-height: 1;
}
.back-btn:hover { background: var(--vscode-list-hoverBackground); }
.back-btn:disabled { opacity: 0.3; cursor: default; }
.header-title {
  font-size: 16px;
  font-weight: 600;
  word-break: break-all;
}
.empty {
  text-align: center;
  margin-top: 48px;
  color: var(--vscode-descriptionForeground);
}
.item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  border-radius: 4px;
  cursor: default;
  border: 1px solid transparent;
  transition: background 0.1s;
}
.item:hover { background: var(--vscode-list-hoverBackground); }
.item.folder { cursor: pointer; }
.item-icon { font-size: 16px; flex-shrink: 0; }
.item-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.item-meta { font-size: 11px; color: var(--vscode-descriptionForeground); white-space: nowrap; }
.load-more {
  display: block;
  width: 100%;
  margin-top: 16px;
  padding: 8px;
  background: var(--vscode-button-secondaryBackground);
  color: var(--vscode-button-secondaryForeground);
  border: 1px solid var(--vscode-button-secondaryBackground);
  cursor: pointer;
  border-radius: 4px;
  font-size: var(--vscode-font-size);
  text-align: center;
}
.load-more:hover:not(:disabled) { background: var(--vscode-button-secondaryHoverBackground); }
.load-more:disabled { opacity: 0.6; cursor: default; }
</style>
</head>
<body>
<div class="header">
  <button class="back-btn" id="backBtn" ${!prefix ? 'disabled' : ''}>&#x2190;</button>
  <span class="header-title">${escapeHtml(prefix || '/')}</span>
</div>
${emptyState}
${allRows}
${loadMoreBtn}
<script>
const vscodeApi = acquireVsCodeApi();

document.querySelectorAll('.folder').forEach(el => {
  el.addEventListener('dblclick', () => {
    vscodeApi.postMessage({ type: 'navigate', prefix: el.dataset.prefix, label: el.dataset.label });
  });
});

const loadMoreBtn = document.getElementById('loadMoreBtn');
if (loadMoreBtn) {
  loadMoreBtn.addEventListener('click', () => {
    vscodeApi.postMessage({ type: 'loadMore' });
  });
}

const backBtn = document.getElementById('backBtn');
if (backBtn && !backBtn.disabled) {
  backBtn.addEventListener('click', () => {
    vscodeApi.postMessage({ type: 'navigateUp' });
  });
}
</script>
</body>
</html>`;
}
