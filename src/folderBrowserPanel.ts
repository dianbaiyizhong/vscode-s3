import * as vscode from 'vscode';
import * as path from 'path';
import { createClient, listObjects, uploadFile, downloadFile, deleteObject, deleteFolder, renameObject, renameFolder, S3ObjectInfo } from './s3Client';
import { ConnectionManager } from './connectionManager';

export class FolderBrowserPanel {

  public static create(
    connectionManager: ConnectionManager,
    connectionId: string,
    prefix: string,
    label: string,
    onNavigate: (connectionId: string, prefix: string) => void
  ): void {
    const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;
    new FolderBrowserPanel(column, connectionManager, connectionId, prefix, label, onNavigate);
  }

  private panel: vscode.WebviewPanel;
  private connectionId: string;
  private prefix: string;
  private connectionName: string;
  private items: S3ObjectInfo[] = [];
  private nextToken?: string;
  private loading = false;
  private refreshing = false;
  private searchPattern?: string;
  private searchToken?: string;

  private constructor(
    column: vscode.ViewColumn,
    private connectionManager: ConnectionManager,
    connectionId: string,
    prefix: string,
    label: string,
    private onNavigate: (connectionId: string, prefix: string) => void
  ) {
    this.connectionId = connectionId;
    this.prefix = prefix;
    const conn = connectionManager.getConnection(connectionId);
    this.connectionName = conn?.name || label;

    this.panel = vscode.window.createWebviewPanel(
      'folderBrowser',
      `${prefix || '/'} — ${this.connectionName}`,
      column,
      { enableScripts: true }
    );
    this.panel.iconPath = new vscode.ThemeIcon('folder-opened');

    this.loadItems().then(() => this.render());

    this.panel.webview.onDidReceiveMessage(async message => {
      switch (message.type) {
        case 'loadMore':
          await this.loadItems();
          this.render();
          break;
        case 'navigate':
          this.searchPattern = undefined;
          this.prefix = message.prefix;
          this.items = [];
          this.nextToken = undefined;
          this.loading = false;
          this.render();
          await this.loadItems();
          this.render();
          this.onNavigate(this.connectionId, message.prefix);
          break;
        case 'navigateUp': {
          this.searchPattern = undefined;
          const parent = this.getParentPrefix();
          this.prefix = parent;
          this.items = [];
          this.nextToken = undefined;
          this.loading = false;
          this.render();
          await this.loadItems();
          this.render();
          this.onNavigate(this.connectionId, parent);
          break;
        }
        case 'goToPath': {
          this.searchPattern = undefined;
          const conn = this.connectionManager.getConnection(this.connectionId);
          if (!conn) return;
          const rawPath = message.path as string || '';
          if (!rawPath) break;
          const trimmed = rawPath.replace(/\/$/, '');
          let newPrefix: string;
          if (!trimmed) {
            newPrefix = '';
          } else {
            const lastSlash = trimmed.lastIndexOf('/');
            newPrefix = lastSlash === -1 ? trimmed + '/' : trimmed.substring(0, lastSlash + 1);
          }
          this.prefix = newPrefix;
          this.items = [];
          this.nextToken = undefined;
          this.loading = false;
          this.render();
          await this.loadItems();
          this.render();
          this.onNavigate(this.connectionId, newPrefix);
          break;
        }
        case 'delete': {
          const conn = this.connectionManager.getConnection(this.connectionId);
          if (!conn) return;
          const item = message.item as S3ObjectInfo;
          const name = item.key.split('/').pop() || item.key;
          const confirmed = await vscode.window.showWarningMessage(
            `Delete ${item.isFolder ? 'folder' : 'file'} "${name}"?`,
            { modal: true },
            'Delete'
          );
          if (confirmed !== 'Delete') return;
          const client = createClient(conn);
          if (item.isFolder) {
            await deleteFolder(client, conn.bucket, item.key);
          } else {
            await deleteObject(client, conn.bucket, item.key);
          }
          this.items = this.items.filter(i => i.key !== item.key);
          this.render();
          break;
        }
        case 'rename': {
          const conn = this.connectionManager.getConnection(this.connectionId);
          if (!conn) return;
          const item = message.item as S3ObjectInfo;
          const oldName = item.key.split('/').pop() || item.key;
          const newName = await vscode.window.showInputBox({
            title: `Rename ${item.isFolder ? 'folder' : 'file'}`,
            value: oldName,
            ignoreFocusOut: true,
          });
          if (!newName || newName === oldName) break;
          const oldKey = item.key;
          const prefix = item.isFolder
            ? item.key.substring(0, item.key.length - oldName.length)
            : item.key.substring(0, item.key.length - oldName.length);
          const newKey = prefix + newName + (item.isFolder && !newName.endsWith('/') ? '/' : '');
          const client = createClient(conn);
          try {
            if (item.isFolder) {
              await renameFolder(client, conn.bucket, oldKey, newKey);
            } else {
              await renameObject(client, conn.bucket, oldKey, newKey);
            }
            this.items = [];
            this.nextToken = undefined;
            this.loading = false;
            await this.loadItems();
            this.render();
          } catch (err: any) {
            vscode.window.showErrorMessage(`Rename failed: ${err.message}`);
          }
          break;
        }
        case 'deleteSelected': {
          const conn = this.connectionManager.getConnection(this.connectionId);
          if (!conn) return;
          const items = message.items as { key: string; isFolder: boolean }[];
          if (!items || items.length === 0) break;
          const confirmed = await vscode.window.showWarningMessage(
            `Delete ${items.length} selected item(s)?`,
            { modal: true },
            'Delete'
          );
          if (confirmed !== 'Delete') return;
          const client = createClient(conn);
          let failCount = 0;
          await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: 'Deleting...' },
            async (progress) => {
              for (let i = 0; i < items.length; i++) {
                progress.report({ message: `${i + 1}/${items.length}` });
                try {
                  if (items[i].isFolder) {
                    await deleteFolder(client, conn.bucket, items[i].key);
                  } else {
                    await deleteObject(client, conn.bucket, items[i].key);
                  }
                } catch { failCount++; }
              }
            }
          );
          this.items = [];
          this.nextToken = undefined;
          this.loading = false;
          await this.loadItems();
          this.render();
          break;
        }
        case 'copyPath': {
          const item = message.item as S3ObjectInfo;
          vscode.env.clipboard.writeText(item.key);
          vscode.window.setStatusBarMessage(`$(link) Copied: ${item.key}`, 3000);
          break;
        }
        case 'download': {
          const conn = this.connectionManager.getConnection(this.connectionId);
          if (!conn) return;
          const item = message.item as S3ObjectInfo;
          if (item.isFolder) return;
          const defaultUri = vscode.Uri.file(item.key.split('/').pop() || item.key);
          const uri = await vscode.window.showSaveDialog({ defaultUri });
          if (!uri) return;
          const client = createClient(conn);
          await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `Downloading ${item.key}` },
            () => downloadFile(client, conn.bucket, item.key, uri.fsPath)
          );
          break;
        }
        case 'refresh':
          this.searchPattern = undefined;
          this.refreshing = true;
          this.items = [];
          this.nextToken = undefined;
          this.loading = false;
          this.render();
          await this.loadItems();
          this.refreshing = false;
          this.render();
          break;
        case 'upload': {
          const conn = this.connectionManager.getConnection(this.connectionId);
          if (!conn) return;
          const uris = await vscode.window.showOpenDialog({
            canSelectMany: true,
            title: `Upload to ${this.prefix || '/'}`,
          });
          if (!uris || uris.length === 0) return;
          const client = createClient(conn);
          let successCount = 0;
          await vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              title: 'Uploading files...',
            },
            async (progress) => {
              for (let i = 0; i < uris.length; i++) {
                const fileName = path.basename(uris[i].fsPath);
                const key = this.prefix + fileName;
                progress.report({ message: `${i + 1}/${uris.length} - ${fileName}` });
                try {
                  await uploadFile(client, conn.bucket, key, uris[i].fsPath);
                  successCount++;
                } catch {}
              }
            }
          );
          if (successCount > 0) {
            this.items = [];
            this.nextToken = undefined;
            this.loading = false;
            await this.loadItems();
            this.render();
          }
          break;
        }
        case 'searchFiles': {
          const pattern = message.pattern as string;
          if (!pattern) break;
          this.searchPattern = pattern;
          this.searchToken = undefined;
          this.items = [];
          this.loading = false;
          this.render();
          await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `Searching "${pattern}"...` },
            async () => {
              await this.loadItems();
            }
          );
          this.render();
          break;
        }
        case 'showError':
          vscode.window.showErrorMessage(message.text);
          break;
        case 'uploadDrop': {
          const conn = this.connectionManager.getConnection(this.connectionId);
          if (!conn) return;
          const fileName = message.fileName as string;
          const base64 = message.content as string;
          if (!fileName || !base64) return;
          const key = this.prefix + fileName;
          const client = createClient(conn);
          try {
            const buffer = Buffer.from(base64, 'base64');
            const { PutObjectCommand } = await import('@aws-sdk/client-s3');
            await client.send(new PutObjectCommand({ Bucket: conn.bucket, Key: key, Body: buffer }));
            this.items = [];
            this.nextToken = undefined;
            this.loading = false;
            await this.loadItems();
            this.render();
          } catch {}
          break;
        }
      }
    });
  }

  private getParentPrefix(): string {
    if (!this.prefix) return '';
    const trimmed = this.prefix.replace(/\/$/, '');
    const lastSlash = trimmed.lastIndexOf('/');
    if (lastSlash === -1) return '';
    return trimmed.substring(0, lastSlash + 1);
  }

  private async loadItems(): Promise<void> {
    if (this.loading) return;
    this.loading = true;
    try {
      const conn = this.connectionManager.getConnection(this.connectionId);
      if (!conn) return;

      if (this.searchPattern) {
        const client = createClient(conn);
        const { ListObjectsV2Command } = await import('@aws-sdk/client-s3');
        const lower = this.searchPattern.toLowerCase();
        do {
          const response = await client.send(new ListObjectsV2Command({
            Bucket: conn.bucket, Prefix: '', MaxKeys: 1000, ContinuationToken: this.searchToken,
          }));
          let matched = 0;
          if (response.Contents) {
            for (const obj of response.Contents) {
              if (obj.Key && obj.Key.toLowerCase().includes(lower)) {
                this.items.push({ key: obj.Key, isFolder: obj.Key.endsWith('/'), size: obj.Size });
                matched++;
              }
            }
          }
          this.searchToken = response.IsTruncated ? response.NextContinuationToken : undefined;
        } while (this.items.length === 0 && this.searchToken);
      } else {
        const client = createClient(conn);
        const result = await listObjects(client, conn.bucket, this.prefix, 1, undefined, this.nextToken);
        this.items.push(...result.items);
        this.nextToken = result.nextToken;
      }
    } finally {
      this.loading = false;
    }
  }

  private render(): void {
    this.panel.title = `${this.refreshing ? '⟳ ' : ''}${this.searchPattern ? '🔍 ' + this.searchPattern : this.prefix || '/'} — ${this.connectionName}`;
    const hasMore = this.searchPattern ? !!this.searchToken : !!this.nextToken;
    this.panel.webview.html = getHtml(
      this.prefix,
      this.items,
      hasMore,
      this.loading || this.refreshing,
      this.refreshing,
      this.searchPattern
    );
  }
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

function getHtml(prefix: string, items: S3ObjectInfo[], hasMore: boolean, loading: boolean, refreshing: boolean = false, searchPattern?: string): string {
  const folderRows = items.filter(i => i.isFolder).map(i => {
    const name = i.key.replace(/\/$/, '').split('/').pop() || '';
    const data = JSON.stringify(i).replace(/"/g, '&quot;');
    return `<div class="item folder" data-item="${data}">
      <input type="checkbox" class="item-cb">
      <span class="item-icon">&#x1F4C1;</span>
      <span class="item-name">${escapeHtml(name)}</span>
      <span class="item-actions">
        <span class="action" data-action="rename" title="Rename">&#x270F;</span>
        <span class="action" data-action="delete" title="Delete">&#x1F5D1;</span>
        <span class="action" data-action="copyPath" title="Copy Path">&#x1F4CB;</span>
      </span>
    </div>`;
  }).join('');

  const fileRows = items.filter(i => !i.isFolder).map(i => {
    const name = i.key.split('/').pop() || i.key;
    const data = JSON.stringify(i).replace(/"/g, '&quot;');
    return `<div class="item file" data-item="${data}">
      <input type="checkbox" class="item-cb">
      <span class="item-icon">&#x1F4C4;</span>
      <span class="item-name">${escapeHtml(name)}</span>
      <span class="item-meta">${formatSize(i.size)}</span>
      <span class="item-actions">
        <span class="action" data-action="rename" title="Rename">&#x270F;</span>
        <span class="action" data-action="download" title="Download">&#x2B07;</span>
        <span class="action" data-action="delete" title="Delete">&#x1F5D1;</span>
        <span class="action" data-action="copyPath" title="Copy Path">&#x1F4CB;</span>
      </span>
    </div>`;
  }).join('');

  const allRows = folderRows + fileRows;

  const loadMoreBtn = hasMore
    ? `<button class="btn" id="loadMoreBtn" ${loading ? 'disabled' : ''}>
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
* { box-sizing: border-box; }
body {
  margin: 0;
  padding: 12px 16px;
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size);
  color: var(--vscode-foreground);
  background: var(--vscode-editor-background);
}
.header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
  padding-bottom: 10px;
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
.path-input {
  flex: 1;
  font-size: 15px;
  font-weight: 600;
  background: transparent;
  border: 1px solid transparent;
  color: var(--vscode-foreground);
  padding: 2px 6px;
  border-radius: 3px;
  outline: none;
  min-width: 0;
}
.path-input:focus {
  border-color: var(--vscode-focusBorder);
  background: var(--vscode-input-background);
}
.action-btn {
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
  border: none;
  padding: 4px 12px;
  cursor: pointer;
  border-radius: 3px;
  font-size: 13px;
  white-space: nowrap;
}
.action-btn:hover { background: var(--vscode-button-hoverBackground); }
.action-btn:disabled { opacity: 0.5; cursor: default; }
.icon-btn {
  background: none;
  border: none;
  color: var(--vscode-foreground);
  cursor: pointer;
  font-size: 16px;
  padding: 2px 6px;
  border-radius: 3px;
  line-height: 1;
  opacity: 0.7;
}
.icon-btn:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground); }
@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
.spinner { display: inline-block; animation: spin 1s linear infinite; }
.sel-bar {
  display: none;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  margin-bottom: 8px;
  background: var(--vscode-list-activeSelectionBackground);
  color: var(--vscode-list-activeSelectionForeground);
  border-radius: 3px;
  font-size: 13px;
}
.sel-bar.show { display: flex; }
.sel-bar .count { flex: 1; }
.sel-bar .del-btn {
  background: var(--vscode-button-secondaryBackground);
  color: var(--vscode-button-secondaryForeground);
  border: none;
  padding: 3px 10px;
  cursor: pointer;
  border-radius: 3px;
  font-size: 12px;
}
.sel-bar .del-btn:hover { background: var(--vscode-button-secondaryHoverBackground); }
.filter-input {
  width: 100%;
  padding: 5px 8px;
  margin-bottom: 8px;
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border);
  border-radius: 3px;
  font-size: 13px;
  outline: none;
  box-sizing: border-box;
}
.filter-input:focus { border-color: var(--vscode-focusBorder); }
.filter-input::placeholder { color: var(--vscode-input-placeholderForeground); }
.empty {
  text-align: center;
  margin-top: 48px;
  color: var(--vscode-descriptionForeground);
}
.item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  border-radius: 3px;
  cursor: default;
  border: 1px solid transparent;
  transition: background 0.1s;
}
.item:hover { background: var(--vscode-list-hoverBackground); }
.item.selected { background: var(--vscode-list-inactiveSelectionBackground); }
.item.folder { cursor: pointer; }
.item-cb {
  flex-shrink: 0;
  width: 14px;
  height: 14px;
  cursor: pointer;
  accent-color: var(--vscode-focusBorder);
}
.item-icon { font-size: 15px; flex-shrink: 0; }
.item-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.item-meta { font-size: 11px; color: var(--vscode-descriptionForeground); white-space: nowrap; margin-right: 4px; }
.item-actions { display: none; gap: 2px; flex-shrink: 0; }
.item:hover .item-actions { display: flex; }
.action {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: 3px;
  cursor: pointer;
  font-size: 14px;
  opacity: 0.7;
  transition: opacity 0.1s, background 0.1s;
}
.action:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground); }
.btn {
  display: block;
  width: 100%;
  margin-top: 12px;
  padding: 6px;
  background: var(--vscode-button-secondaryBackground);
  color: var(--vscode-button-secondaryForeground);
  border: 1px solid var(--vscode-button-secondaryBackground);
  cursor: pointer;
  border-radius: 3px;
  font-size: var(--vscode-font-size);
  text-align: center;
}
.btn:hover:not(:disabled) { background: var(--vscode-button-secondaryHoverBackground); }
.btn:disabled { opacity: 0.6; cursor: default; }
.drag-overlay {
  display: none;
  position: fixed;
  top: 0; left: 0; right: 0; bottom: 0;
  border: 3px dashed var(--vscode-focusBorder);
  background: var(--vscode-editor-background);
  opacity: 0.85;
  align-items: center;
  justify-content: center;
  font-size: 18px;
  font-weight: 600;
  pointer-events: none;
  z-index: 999;
}
.drag-overlay.show { display: flex; }
.cm {
  display: none;
  position: fixed;
  z-index: 1000;
  background: var(--vscode-menu-background);
  border: 1px solid var(--vscode-menu-border);
  border-radius: 4px;
  padding: 4px 0;
  min-width: 140px;
  box-shadow: 0 2px 8px rgba(0,0,0,0.3);
}
.cm.show { display: block; }
.cm-item {
  padding: 5px 16px;
  cursor: pointer;
  font-size: 13px;
  color: var(--vscode-menu-foreground);
}
.cm-item:hover { background: var(--vscode-menu-selectionBackground); color: var(--vscode-menu-selectionForeground); }
.cm-sep {
  height: 1px;
  margin: 4px 8px;
  background: var(--vscode-menu-separatorBackground);
}
</style>
</head>
<body>
<div class="drag-overlay" id="dragOverlay">Drop files to upload</div>
<div class="header">
  <button class="back-btn" id="backBtn" ${!prefix ? 'disabled' : ''}>&#x2190;</button>
  ${refreshing ? '<span class="spinner">⟳</span>' : ''}
  <input class="path-input" id="pathInput" value="${escapeHtml(prefix || '/')}" title="Enter path and press Enter to navigate">
  <button class="action-btn" id="refreshBtn" ${refreshing ? 'disabled' : ''}>${refreshing ? '⟳' : '&#x21BB;'} Refresh</button>
  <button class="action-btn" id="uploadBtn">&#x2B06; Upload</button>
</div>
<div class="sel-bar" id="selBar">
  <span class="count" id="selCount">0 selected</span>
  <button class="del-btn" id="delSelectedBtn">Delete Selected</button>
</div>
<input class="filter-input" id="filterInput" type="text" placeholder="Type to filter, press Enter to search all..." value="${searchPattern ? escapeHtml(searchPattern) : ''}"${searchPattern ? ' data-searching="1"' : ''} autocomplete="off">
${emptyState}
${allRows}
${loadMoreBtn}
<div class="cm" id="ctxMenu"></div>
<script>
const vscodeApi = acquireVsCodeApi();

// selection
const selBar = document.getElementById('selBar');
const selCount = document.getElementById('selCount');
const delBtn = document.getElementById('delSelectedBtn');

document.addEventListener('change', e => {
  const cb = e.target.closest('.item-cb');
  if (!cb) return;
  cb.closest('.item').classList.toggle('selected', cb.checked);
  updateSelBar();
});

function updateSelBar() {
  const checked = document.querySelectorAll('.item-cb:checked');
  if (checked.length === 0) {
    selBar.classList.remove('show');
    return;
  }
  selBar.classList.add('show');
  selCount.textContent = checked.length + ' selected';
}

delBtn.addEventListener('click', () => {
  const checked = document.querySelectorAll('.item-cb:checked');
  const items = Array.from(checked).map(cb => {
    const el = cb.closest('.item');
    return JSON.parse(el.dataset.item);
  });
  vscodeApi.postMessage({ type: 'deleteSelected', items });
});

// context menu
const ctxMenu = document.getElementById('ctxMenu');

document.addEventListener('contextmenu', e => {
  const itemEl = e.target.closest('.item');
  if (!itemEl) { ctxMenu.classList.remove('show'); return; }
  e.preventDefault();
  const item = JSON.parse(itemEl.dataset.item);
  const isFile = !item.isFolder;
  ctxMenu.innerHTML = '';
  const addItem = (label, action) => {
    const div = document.createElement('div');
    div.className = 'cm-item';
    div.textContent = label;
    div.addEventListener('click', () => { ctxMenu.classList.remove('show'); vscodeApi.postMessage({ type: action, item }); });
    ctxMenu.appendChild(div);
  };
  addItem('✏ Rename', 'rename');
  if (isFile) addItem('⬇ Download', 'download');
  addItem('🗑 Delete', 'delete');
  addItem('📋 Copy Path', 'copyPath');
  ctxMenu.style.left = e.clientX + 'px';
  ctxMenu.style.top = e.clientY + 'px';
  ctxMenu.classList.add('show');
});

document.addEventListener('click', e => {
  if (!e.target.closest('#ctxMenu')) ctxMenu.classList.remove('show');
});

// drag-and-drop — use capture phase to intercept before VS Code
let dragCounter = 0;
const overlay = document.getElementById('dragOverlay');

['dragenter', 'dragover', 'dragleave', 'drop'].forEach(type => {
  document.addEventListener(type, e => {
    e.preventDefault();
    e.stopPropagation();
  }, true);
});

document.addEventListener('dragenter', e => {
  dragCounter++;
  overlay.classList.add('show');
}, true);

document.addEventListener('dragleave', e => {
  dragCounter--;
  if (dragCounter <= 0) { dragCounter = 0; overlay.classList.remove('show'); }
}, true);

document.addEventListener('drop', async e => {
  dragCounter = 0;
  overlay.classList.remove('show');
  const files = Array.from(e.dataTransfer.files);
  if (files.length === 0) return;
  const maxSize = 100 * 1024 * 1024;
  for (const file of files) {
    if (file.size > maxSize) {
      vscodeApi.postMessage({ type: 'showError', text: 'File too large (max 100MB): ' + file.name });
      continue;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result;
      const base64 = dataUrl.split(',')[1];
      vscodeApi.postMessage({ type: 'uploadDrop', fileName: file.name, content: base64 });
    };
    reader.readAsDataURL(file);
  }
}, true);

// actions
document.addEventListener('click', e => {
  const action = e.target.closest('.action');
  if (!action) return;
  const itemEl = action.closest('.item');
  if (!itemEl) return;
  const act = action.dataset.action;
  const item = JSON.parse(itemEl.dataset.item);
  vscodeApi.postMessage({ type: act, item });
});

// folder double-click
document.querySelectorAll('.folder').forEach(el => {
  el.addEventListener('dblclick', () => {
    const item = JSON.parse(el.dataset.item);
    vscodeApi.postMessage({ type: 'navigate', prefix: item.key, label: item.key.split('/').filter(Boolean).pop() || '' });
  });
});

document.getElementById('loadMoreBtn')?.addEventListener('click', () => {
  vscodeApi.postMessage({ type: 'loadMore' });
});

const backBtn = document.getElementById('backBtn');
if (backBtn && !backBtn.disabled) {
  backBtn.addEventListener('click', () => {
    vscodeApi.postMessage({ type: 'navigateUp' });
  });
}

document.getElementById('uploadBtn')?.addEventListener('click', () => {
  vscodeApi.postMessage({ type: 'upload' });
});
const filterInput = document.getElementById('filterInput');
filterInput?.addEventListener('input', () => {
  const q = filterInput.value.toLowerCase();
  if (filterInput.dataset.searching) {
    document.querySelectorAll('.item').forEach(el => {
      const name = el.querySelector('.item-name')?.textContent?.toLowerCase() || '';
      el.style.display = !q || name.includes(q) ? '' : 'none';
    });
  }
});
filterInput?.addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    e.preventDefault();
    const val = filterInput.value.trim();
    if (!val) { filterInput.value = ''; filterInput.dataset.searching = ''; vscodeApi.postMessage({ type: 'refresh' }); return; }
    filterInput.dataset.searching = '1';
    vscodeApi.postMessage({ type: 'searchFiles', pattern: val });
  } else if (e.key === 'Escape') {
    filterInput.value = '';
    filterInput.blur();
    if (filterInput.dataset.searching) {
      filterInput.dataset.searching = '';
      vscodeApi.postMessage({ type: 'refresh' });
    }
  }
});
document.getElementById('pathInput')?.addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    e.preventDefault();
    vscodeApi.postMessage({ type: 'goToPath', path: e.target.value });
  }
});
document.getElementById('refreshBtn')?.addEventListener('click', () => {
  vscodeApi.postMessage({ type: 'refresh' });
});
</script>
</body>
</html>`;
}
