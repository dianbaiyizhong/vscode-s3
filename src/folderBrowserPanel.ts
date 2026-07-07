import * as vscode from 'vscode';
import * as path from 'path';
import { createClient, listObjects, uploadFile, downloadFile, deleteObject, deleteFolder, renameObject, renameFolder, S3ObjectInfo } from './s3Client';
import { ConnectionManager } from './connectionManager';
import { t } from './i18n';

export class FolderBrowserPanel {

  public static create(
    connectionManager: ConnectionManager,
    connectionId: string,
    prefix: string,
    label: string,
    onNavigate: (connectionId: string, prefix: string) => void,
    skipInitialLoad = false
  ): FolderBrowserPanel {
    const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;
    return new FolderBrowserPanel(column, connectionManager, connectionId, prefix, label, onNavigate, skipInitialLoad);
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
  private singleFileKey?: string;

  private constructor(
    column: vscode.ViewColumn,
    private connectionManager: ConnectionManager,
    connectionId: string,
    prefix: string,
    label: string,
    private onNavigate: (connectionId: string, prefix: string) => void,
    skipInitialLoad = false
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

    if (!skipInitialLoad) {
      this.loadItems().then(() => this.render());
    } else {
      this.render();
    }

    this.panel.webview.onDidReceiveMessage(async message => {
      switch (message.type) {
        case 'loadMore':
          await this.loadItems();
          this.render();
          break;
        case 'navigate':
          this.searchPattern = undefined;
          this.singleFileKey = undefined;
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
          this.singleFileKey = undefined;
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
          const rawPath = message.path as string || '';
          if (!rawPath) break;
          await this.goToPath(rawPath);
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
          if (this.singleFileKey === item.key) {
            this.singleFileKey = undefined;
            this.nextToken = undefined;
            await this.loadItems();
          }
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
          this.singleFileKey = undefined;
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
        case 'info': {
          const conn = this.connectionManager.getConnection(this.connectionId);
          if (!conn) return;
          const item = message.item as S3ObjectInfo;
          const client = createClient(conn);
          const { HeadObjectCommand } = await import('@aws-sdk/client-s3');
          const items: { label: string; value: string }[] = [
            { label: 'Key', value: item.key },
            { label: 'Type', value: item.isFolder ? 'Folder' : 'File' },
            { label: 'Size', value: item.size != null ? formatSize(item.size) : '-' },
            { label: 'Last Modified', value: item.lastModified ? new Date(item.lastModified).toISOString() : '-' },
          ];
          try {
            const head = await client.send(new HeadObjectCommand({ Bucket: conn.bucket, Key: item.key }));
            if (head.ETag) items.push({ label: 'ETag', value: head.ETag.replace(/"/g, '') });
            if (head.ContentType) items.push({ label: 'Content-Type', value: head.ContentType });
            if (head.ContentEncoding) items.push({ label: 'Content-Encoding', value: head.ContentEncoding });
            if (head.StorageClass) items.push({ label: 'Storage Class', value: head.StorageClass });
            if (head.VersionId) items.push({ label: 'Version ID', value: head.VersionId });
            if (head.ContentDisposition) items.push({ label: 'Content-Disposition', value: head.ContentDisposition });
            if (head.CacheControl) items.push({ label: 'Cache-Control', value: head.CacheControl });
            if (head.ServerSideEncryption) items.push({ label: 'Encryption', value: head.ServerSideEncryption });
            if (head.SSEKMSKeyId) items.push({ label: 'KMS Key ID', value: head.SSEKMSKeyId });
            if (head.WebsiteRedirectLocation) items.push({ label: 'Website Redirect', value: head.WebsiteRedirectLocation });
            if (head.Metadata && Object.keys(head.Metadata).length > 0) {
              for (const [k, v] of Object.entries(head.Metadata)) {
                items.push({ label: `Metadata: ${k}`, value: v || '' });
              }
            }
          } catch { /* use basic info */ }
          const picks = items.map(i => ({
            label: i.label,
            description: i.value,
          }));
          const pick = await vscode.window.showQuickPick(picks, {
            title: `Info: ${item.key}`,
            placeHolder: 'Click to copy value',
            matchOnDescription: true,
          });
          if (pick) {
            vscode.env.clipboard.writeText(pick.description || '');
            vscode.window.setStatusBarMessage(`$(link) Copied: ${pick.description}`, 2000);
          }
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
          this.loading = false;
          if (this.singleFileKey) {
            this.render();
            await vscode.window.withProgress(
              { location: vscode.ProgressLocation.Window, title: 'Refreshing...' },
              async () => {
                const conn = this.connectionManager.getConnection(this.connectionId);
                if (!conn) return;
                const client = createClient(conn);
                const { HeadObjectCommand } = await import('@aws-sdk/client-s3');
                try {
                  const head = await client.send(new HeadObjectCommand({ Bucket: conn.bucket, Key: this.singleFileKey! }));
                  this.items = [{ key: this.singleFileKey!, isFolder: false, size: head.ContentLength, lastModified: head.LastModified }];
                } catch {
                  vscode.window.showInformationMessage(`File no longer exists: ${this.singleFileKey}`);
                  this.singleFileKey = undefined;
                  this.items = [];
                  this.nextToken = undefined;
                  this.prefix = this.prefix || '';
                  await this.loadItems();
                }
              }
            );
          } else {
            this.items = [];
            this.nextToken = undefined;
            this.render();
            await vscode.window.withProgress(
              { location: vscode.ProgressLocation.Window, title: 'Refreshing...' },
              () => this.loadItems()
            );
          }
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
          let failCount = 0;
          await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Window, title: 'Uploading...' },
            async (progress) => {
              for (let i = 0; i < uris.length; i++) {
                const fileName = path.basename(uris[i].fsPath);
                const key = this.prefix + fileName;
                progress.report({ message: `${i + 1}/${uris.length} ${fileName}`, increment: Math.round(100 / uris.length) });
                try {
                  await uploadFile(client, conn.bucket, key, uris[i].fsPath);
                  successCount++;
                } catch (err: any) {
                  failCount++;
                  vscode.window.showErrorMessage(`Upload failed: ${fileName} - ${err.message}`);
                }
              }
            }
          );
          if (successCount > 0) {
            this.items = [];
            this.nextToken = undefined;
            this.loading = false;
            if (this.singleFileKey) {
              const client = createClient(conn);
              const { HeadObjectCommand } = await import('@aws-sdk/client-s3');
              try {
                const head = await client.send(new HeadObjectCommand({ Bucket: conn.bucket, Key: this.singleFileKey }));
                this.items = [{ key: this.singleFileKey, isFolder: false, size: head.ContentLength, lastModified: head.LastModified }];
              } catch {
                this.singleFileKey = undefined;
              }
            } else {
              await this.loadItems();
            }
            this.render();
          }
          if (failCount > 0 && successCount > 0) {
            vscode.window.showWarningMessage(`Uploaded ${successCount} file(s), ${failCount} failed`);
          } else if (successCount > 0 && failCount === 0) {
            vscode.window.showInformationMessage(`Uploaded ${successCount} file(s) successfully`);
          }
          break;
        }
        case 'searchFiles': {
          const pattern = message.pattern as string;
          if (!pattern) break;
          if (pattern.includes('/')) {
            this.searchPattern = undefined;
            const trimmed = pattern.replace(/\/$/, '');
            const lastSlash = trimmed.lastIndexOf('/');
            const lastSegment = lastSlash === -1 ? pattern : trimmed.substring(lastSlash + 1);
            if (pattern.endsWith('/') || !lastSegment.includes('.')) {
              this.singleFileKey = undefined;
              this.prefix = pattern.endsWith('/') ? pattern : pattern + '/';
              this.items = [];
              this.nextToken = undefined;
              this.loading = false;
              this.render();
              await this.loadItems();
              this.render();
            } else {
              this.singleFileKey = undefined;
              this.prefix = lastSlash === -1 ? '' : trimmed.substring(0, lastSlash + 1);
              this.items = [];
              this.nextToken = undefined;
              this.loading = false;
              this.render();
              const fullKey = pattern;
              const client = createClient(conn);
              const { HeadObjectCommand } = await import('@aws-sdk/client-s3');
              try {
                const head = await client.send(new HeadObjectCommand({ Bucket: conn.bucket, Key: fullKey }));
                this.singleFileKey = fullKey;
                this.items = [{ key: fullKey, isFolder: false, size: head.ContentLength, lastModified: head.LastModified }];
                this.render();
                this.panel.webview.postMessage({ type: 'highlight', name: lastSegment });
              } catch {
                vscode.window.showInformationMessage(`File not found: ${fullKey}`);
                this.prefix = this.prefix || '';
            this.items = [];
            this.nextToken = undefined;
            this.singleFileKey = undefined;
            this.loading = false;
                this.render();
                await this.loadItems();
                this.render();
              }
            }
          } else {
            this.singleFileKey = undefined;
            this.searchPattern = pattern;
            this.items = [];
            this.nextToken = undefined;
            this.render();
            await vscode.window.withProgress(
              { location: vscode.ProgressLocation.Notification, title: `Searching "${pattern}" in ${this.prefix || '/'}...` },
              async () => {
                await this.loadAllSearchPages();
              }
            );
            if (this.items.length === 0) {
              vscode.window.showInformationMessage(`No items matching "${pattern}" found`);
            }
            this.render();
          }
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
          if (!fileName || !base64) break;
          const key = this.prefix + fileName;
          const client = createClient(conn);
          try {
            await vscode.window.withProgress(
              { location: vscode.ProgressLocation.Window, title: `Uploading ${fileName}...` },
              async () => {
                const buffer = Buffer.from(base64, 'base64');
                const { PutObjectCommand } = await import('@aws-sdk/client-s3');
                await client.send(new PutObjectCommand({ Bucket: conn.bucket, Key: key, Body: buffer }));
              }
            );
            this.items = [];
            this.nextToken = undefined;
            this.loading = false;
            if (this.singleFileKey) {
              const { HeadObjectCommand } = await import('@aws-sdk/client-s3');
              try {
                const head = await client.send(new HeadObjectCommand({ Bucket: conn.bucket, Key: this.singleFileKey }));
                this.items = [{ key: this.singleFileKey, isFolder: false, size: head.ContentLength, lastModified: head.LastModified }];
              } catch {
                this.singleFileKey = undefined;
              }
            } else {
              await this.loadItems();
            }
            this.render();
            vscode.window.showInformationMessage(`Uploaded ${fileName} successfully`);
          } catch (err: any) {
            vscode.window.showErrorMessage(`Upload failed: ${fileName} - ${err.message}`);
          }
          break;
        }
      }
    });
  }

  public async goToPath(rawPath: string): Promise<void> {
    this.searchPattern = undefined;
    const conn = this.connectionManager.getConnection(this.connectionId);
    if (!conn) return;
    if (!rawPath) return;
    let newPrefix: string;
    let targetFile: string | undefined;
    if (rawPath === '/') {
      newPrefix = '';
    } else if (rawPath.endsWith('/')) {
      newPrefix = rawPath;
    } else {
      const trimmed = rawPath.replace(/\/$/, '');
      const lastSlash = trimmed.lastIndexOf('/');
      const lastSegment = lastSlash === -1 ? trimmed : trimmed.substring(lastSlash + 1);
      if (lastSegment.includes('.')) {
        newPrefix = lastSlash === -1 ? '' : trimmed.substring(0, lastSlash + 1);
        targetFile = lastSegment;
      } else {
        newPrefix = rawPath + '/';
      }
    }
    this.prefix = newPrefix;
    this.items = [];
    this.nextToken = undefined;
    this.loading = false;
    if (targetFile) {
      this.singleFileKey = undefined;
      this.render();
      const fullKey = rawPath;
      const client = createClient(conn);
      const { HeadObjectCommand } = await import('@aws-sdk/client-s3');
      try {
        const head = await client.send(new HeadObjectCommand({ Bucket: conn.bucket, Key: fullKey }));
        this.singleFileKey = fullKey;
        this.items = [{ key: fullKey, isFolder: false, size: head.ContentLength, lastModified: head.LastModified }];
        this.render();
        this.panel.webview.postMessage({ type: 'highlight', name: targetFile });
      } catch {
        vscode.window.showInformationMessage(`File not found: ${fullKey}`);
        this.items = [];
        this.nextToken = undefined;
        this.loading = false;
        this.render();
        await this.loadItems();
        this.render();
      }
    } else {
      this.singleFileKey = undefined;
      this.render();
      await this.loadItems();
      this.render();
    }
    this.onNavigate(this.connectionId, targetFile ? rawPath : newPrefix);
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

      const client = createClient(conn);
      const result = await listObjects(client, conn.bucket, this.prefix, 1, undefined, this.nextToken);
      if (this.searchPattern) {
        const lower = this.searchPattern.toLowerCase();
        const matched = result.items.filter(i => i.key.replace(/\/$/, '').split('/').pop()?.toLowerCase().includes(lower));
        this.items.push(...matched);
        this.nextToken = result.nextToken;
      } else {
        this.items.push(...result.items);
        this.nextToken = result.nextToken;
      }
    } finally {
      this.loading = false;
    }
  }

  private async loadAllSearchPages(): Promise<void> {
    while (true) {
      if (this.loading) return;
      this.loading = true;
      try {
        const conn = this.connectionManager.getConnection(this.connectionId);
        if (!conn) return;

        const client = createClient(conn);
        const result = await listObjects(client, conn.bucket, this.prefix, 1, undefined, this.nextToken);
        const lower = this.searchPattern!.toLowerCase();
        const matched = result.items.filter(i => i.key.replace(/\/$/, '').split('/').pop()?.toLowerCase().includes(lower));
        this.items.push(...matched);
        this.nextToken = result.nextToken;
        if (this.items.length > 0 || this.nextToken === undefined) break;
      } finally {
        this.loading = false;
      }
    }
  }

  private render(): void {
    const displayPath = this.singleFileKey || this.prefix || '/';
    this.panel.title = `${this.searchPattern ? '🔍 ' + this.searchPattern : displayPath} — ${this.connectionName}`;
    this.panel.webview.html = getHtml(
      displayPath,
      this.items,
      this.nextToken !== undefined,
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
  const headerRow = `<div class="list-header">
    <span></span>
    <span></span>
    <span onclick="sortBy('name')">${t('wv_name')}<span class="sort-icon"></span></span>
    <span onclick="sortBy('size')">${t('wv_size')}<span class="sort-icon"></span></span>
    <span onclick="sortBy('date')">${t('wv_modified')}<span class="sort-icon"></span></span>
    <span>${t('wv_actions')}</span>
  </div>`;

  const folderRows = items.filter(i => i.isFolder).map(i => {
    const name = i.key.replace(/\/$/, '').split('/').pop() || '';
    const data = JSON.stringify(i).replace(/"/g, '&quot;');
    return `<div class="item folder" data-item="${data}">
      <input type="checkbox" class="item-cb">
      <span class="item-icon">&#x1F4C1;</span>
      <span class="item-name">${escapeHtml(name)}</span>
      <span class="item-meta"></span>
      <span class="item-date"></span>
      <span class="item-actions">
        <span class="action" data-action="info" title="${t('wv_info')}">&#x2139;</span>
        <span class="action" data-action="rename" title="${t('wv_rename')}">&#x270F;</span>
        <span class="action" data-action="delete" title="${t('wv_delete')}">&#x1F5D1;</span>
        <span class="action" data-action="copyPath" title="${t('wv_copyPath')}">&#x1F4CB;</span>
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
      <span class="item-date">${i.lastModified ? formatDate(new Date(i.lastModified)) : ''}</span>
      <span class="item-actions">
        <span class="action" data-action="info" title="${t('wv_info')}">&#x2139;</span>
        <span class="action" data-action="rename" title="${t('wv_rename')}">&#x270F;</span>
        <span class="action" data-action="download" title="${t('wv_download')}">&#x2B07;</span>
        <span class="action" data-action="delete" title="${t('wv_delete')}">&#x1F5D1;</span>
        <span class="action" data-action="copyPath" title="${t('wv_copyPath')}">&#x1F4CB;</span>
      </span>
    </div>`;
  }).join('');

  const allRows = folderRows + fileRows;

  const loadMoreBtn = hasMore
    ? `<button class="btn" id="loadMoreBtn" ${loading ? 'disabled' : ''}>
        ${loading ? t('wv_loading') : t('wv_loadMore')}
       </button>`
    : '';

  const emptyState = !allRows && !loading
    ? `<div class="empty">${t('wv_empty')}</div>`
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
  background: transparent;
  color: var(--vscode-foreground);
  border: none;
  padding: 2px 6px;
  cursor: pointer;
  border-radius: 3px;
  font-size: 13px;
  white-space: nowrap;
  line-height: 1;
}
.action-btn:hover { background: var(--vscode-toolbar-hoverBackground); }
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
.list-header, .item {
  display: grid;
  grid-template-columns: var(--col-cb, 28px) var(--col-icon, 24px) var(--col-name, 1fr) var(--col-size, 90px) var(--col-date, 140px) var(--col-actions, 120px);
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  border-radius: 3px;
}
.list-header {
  font-size: 11px;
  font-weight: 600;
  color: var(--vscode-descriptionForeground);
  border-bottom: 1px solid var(--vscode-panel-border);
  margin-bottom: 4px;
  padding-bottom: 4px;
  user-select: none;
}
.list-header > span { cursor: pointer; }
.list-header > span:hover { color: var(--vscode-foreground); }
.list-header .sort-icon { margin-left: 2px; font-size: 10px; }
.item {
  cursor: default;
  border: 1px solid transparent;
  transition: background 0.1s;
}
.item:hover { background: var(--vscode-list-hoverBackground); }
.item.selected { background: var(--vscode-list-inactiveSelectionBackground); }
.item.folder { cursor: pointer; }
.item-cb {
  width: 14px;
  height: 14px;
  cursor: pointer;
  accent-color: var(--vscode-focusBorder);
}
.item-icon { font-size: 15px; text-align: center; }
.item-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.item-meta { font-size: 11px; color: var(--vscode-descriptionForeground); text-align: left; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.item-date { font-size: 11px; color: var(--vscode-descriptionForeground); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.item-actions { display: flex; gap: 2px; }
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
<div class="drag-overlay" id="dragOverlay">${t('wv_dropUpload')}</div>
<div class="header">
  <button class="back-btn" id="backBtn" ${!prefix ? 'disabled' : ''}>&#x2190;</button>
  <input class="path-input" id="pathInput" value="${escapeHtml(prefix || '/')}" title="Enter path and press Enter to navigate">
  <button class="action-btn" id="refreshBtn" ${refreshing ? 'disabled' : ''}>${t('wv_refresh')}</button>
  <button class="action-btn" id="uploadBtn">${t('wv_upload')}</button>
</div>
<div class="sel-bar" id="selBar">
  <span class="count" id="selCount" data-format="${t('wv_selected')}">${t('wv_selected', '0')}</span>
  <button class="del-btn" id="delSelectedBtn">${t('wv_deleteSelected')}</button>
</div>
<input class="filter-input" id="filterInput" type="text" placeholder="${t('wv_filterPlaceholder')}" value="${searchPattern ? escapeHtml(searchPattern) : ''}"${searchPattern ? ' data-searching="1"' : ''} autocomplete="off">
${emptyState}
${headerRow}
${allRows}
${loadMoreBtn}
<div class="cm" id="ctxMenu"></div>
<script>
const vscodeApi = acquireVsCodeApi();
const l10n = ${JSON.stringify({
    rename: t('wv_rename'),
    download: t('wv_download'),
    delete: t('wv_delete'),
    copyPath: t('wv_copyPath'),
    info: t('wv_info'),
    selected: t('wv_selected'),
  })};

let sortCol = '';
let sortDir = 1;
function sortBy(col) {
  if (sortCol === col) sortDir *= -1; else { sortCol = col; sortDir = 1; }
  const container = document.body;
  const items = Array.from(document.querySelectorAll('.item'));
  const header = document.querySelector('.list-header');
  const loadMoreBtn = document.getElementById('loadMoreBtn');
  const refNode = loadMoreBtn || header?.nextSibling || null;
  const headers = document.querySelectorAll('.list-header .sort-icon');
  headers.forEach(h => h.textContent = '');
  const activeHeader = document.querySelectorAll('.list-header > span')[['name','size','date'].indexOf(col) + 2];
  if (activeHeader) activeHeader.querySelector('.sort-icon').textContent = sortDir > 0 ? '▲' : '▼';
  items.sort((a, b) => {
    const va = a.dataset.item ? JSON.parse(a.dataset.item) : {};
    const vb = b.dataset.item ? JSON.parse(b.dataset.item) : {};
    let cmp = 0;
    if (col === 'name') cmp = va.key.localeCompare(vb.key);
    else if (col === 'size') cmp = (va.size || 0) - (vb.size || 0);
    else if (col === 'date') cmp = new Date(va.lastModified||0) - new Date(vb.lastModified||0);
    return cmp * sortDir;
  });
  items.forEach(el => container.insertBefore(el, refNode));
}

// column resize
const colVars = ['cb','icon','name','size','date','actions'];
let resizeData = null;
document.addEventListener('mousedown', e => {
  const headerCell = e.target.closest('.list-header > span');
  if (!headerCell) return;
  const idx = Array.from(headerCell.parentNode.children).indexOf(headerCell);
  if (idx < 2 || idx > 4) return;
  const rect = headerCell.getBoundingClientRect();
  if (e.clientX < rect.right - 6 && e.clientX > rect.left + 6) return;
  const startX = e.clientX;
  const startW = rect.width;
  resizeData = { idx, startX, startW };
  e.preventDefault();
});
document.addEventListener('mousemove', e => {
  if (!resizeData) return;
  const { idx, startX, startW } = resizeData;
  const dx = e.clientX - startX;
  const newW = Math.max(40, startW + dx);
  document.body.style.setProperty('--col-' + colVars[idx], newW + 'px');
});
document.addEventListener('mouseup', () => {
  if (!resizeData) return;
  const vals = {};
  colVars.forEach(v => {
    const val = document.body.style.getPropertyValue('--col-' + v);
    if (val) vals[v] = val;
  });
  vscodeApi.setState({ ...(vscodeApi.getState() || {}), colWidths: vals });
  resizeData = null;
});

// restore saved widths
const saved = vscodeApi.getState();
if (saved?.colWidths) {
  colVars.forEach(v => {
    if (saved.colWidths[v]) document.body.style.setProperty('--col-' + v, saved.colWidths[v]);
  });
}

// highlight target file
window.addEventListener('message', e => {
  if (e.data.type === 'highlight') {
    const items = document.querySelectorAll('.item');
    for (const el of items) {
      const name = el.querySelector('.item-name')?.textContent;
      if (name === e.data.name) {
        el.style.background = 'var(--vscode-list-activeSelectionBackground)';
        el.style.color = 'var(--vscode-list-activeSelectionForeground)';
        el.scrollIntoView({ block: 'center' });
        setTimeout(() => { el.style.transition = 'background 1s'; el.style.background = ''; el.style.color = ''; }, 2000);
        break;
      }
    }
  }
});

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
  const fmt = selCount.dataset.format || '{0} selected';
  selCount.textContent = fmt.replace('{0}', checked.length);
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
  addItem('ℹ ' + l10n.info, 'info');
  addItem('✏ ' + l10n.rename, 'rename');
  if (isFile) addItem('⬇ ' + l10n.download, 'download');
  addItem('🗑 ' + l10n.delete, 'delete');
  addItem('📋 ' + l10n.copyPath, 'copyPath');
  ctxMenu.style.left = e.clientX + 'px';
  ctxMenu.style.top = e.clientY + 'px';
  ctxMenu.classList.add('show');
});

document.addEventListener('click', e => {
  if (!e.target.closest('#ctxMenu')) ctxMenu.classList.remove('show');
});

// drag-and-drop
const overlay = document.getElementById('dragOverlay');

document.addEventListener('dragenter', e => {
  e.preventDefault();
  e.dataTransfer.effectAllowed = 'copy';
  overlay.classList.add('show');
}, true);

document.addEventListener('dragover', e => {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
}, true);

document.addEventListener('dragleave', e => {
  e.preventDefault();
  if (e.target === document || e.target === document.body) {
    overlay.classList.remove('show');
  }
}, true);

document.addEventListener('drop', async e => {
  e.preventDefault();
  e.stopPropagation();
  e.dataTransfer.dropEffect = 'copy';
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
  if (e.isComposing) return;
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
  if (e.isComposing) return;
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
