import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { createClient, listObjects, uploadFile, downloadFile, deleteObject, deleteFolder, renameObject, renameFolder, S3ObjectInfo } from './s3Client';
import { ConnectionManager } from './connectionManager';
import { JumpRecord } from './jumpHistory';
import { t } from './i18n';

export class FolderBrowserPanel {

  public static create(
    connectionManager: ConnectionManager,
    connectionId: string,
    prefix: string,
    label: string,
    onNavigate: (connectionId: string, prefix: string) => void,
    getHistoryRecords?: () => JumpRecord[],
    skipInitialLoad = false
  ): FolderBrowserPanel {
    const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;
    return new FolderBrowserPanel(column, connectionManager, connectionId, prefix, label, onNavigate, getHistoryRecords, skipInitialLoad);
  }

  private panel: vscode.WebviewPanel;
  private connectionId: string;
  private prefix: string;
  private connectionName: string;
  private getHistoryRecords: (() => JumpRecord[]) | undefined;
  private items: S3ObjectInfo[] = [];
  private nextToken?: string;
  private loading = false;
  private refreshing = false;
  private searchPattern?: string;
  private singleFileKey?: string;
  private searchPrefix?: string;
  private static folderIcon: string = '';
  private static fileIcon: string = '';
  private static extIcons: Record<string, string> = {};
  private static actionIcons: Record<string, string> = {};
  private static backIcon: string = '';

  private constructor(
    column: vscode.ViewColumn,
    private connectionManager: ConnectionManager,
    connectionId: string,
    prefix: string,
    label: string,
    private onNavigate: (connectionId: string, prefix: string) => void,
    getHistoryRecords?: () => JumpRecord[],
    skipInitialLoad = false
  ) {
    this.connectionId = connectionId;
    this.prefix = prefix;
    this.getHistoryRecords = getHistoryRecords;
    const conn = connectionManager.getConnection(connectionId);
    this.connectionName = conn?.name || label;

    if (!FolderBrowserPanel.folderIcon) {
      const extPath = vscode.extensions.getExtension('nntk.vscode-s3')?.extensionPath;
      if (extPath) {
        FolderBrowserPanel.folderIcon = fs.readFileSync(path.join(extPath, 'resources', 'folder.svg'), 'utf-8');
        FolderBrowserPanel.fileIcon = fs.readFileSync(path.join(extPath, 'resources', 'file.svg'), 'utf-8');
        const iconsDir = path.join(extPath, 'resources', 'file-icons');
        if (fs.existsSync(iconsDir)) {
          for (const f of fs.readdirSync(iconsDir)) {
            const ext = path.parse(f).name.toLowerCase();
            FolderBrowserPanel.extIcons[ext] = fs.readFileSync(path.join(iconsDir, f), 'utf-8');
          }
        }
        const actionDir = path.join(extPath, 'resources', 'action-icons');
        if (fs.existsSync(actionDir)) {
          for (const f of fs.readdirSync(actionDir)) {
            const name = path.parse(f).name.toLowerCase();
            FolderBrowserPanel.actionIcons[name] = fs.readFileSync(path.join(actionDir, f), 'utf-8');
          }
        }
        FolderBrowserPanel.backIcon = FolderBrowserPanel.actionIcons['back'] || '&#x2190;';
      }
    }

    const initPath = (prefix || '/').length > 15 ? '…' + (prefix || '/').slice(-15) : (prefix || '/');
    this.panel = vscode.window.createWebviewPanel(
      'folderBrowser',
      `${prefix || '/'} — ${this.connectionName}`,
      column,
      { enableScripts: true }
    );
    this.panel.iconPath = new vscode.ThemeIcon('window');

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
          this.searchPrefix = undefined;
          this.singleFileKey = undefined;
          this.prefix = message.prefix;
          this.items = [];
          this.nextToken = undefined;
          this.loading = false;
          this.render();
          this.onNavigate(this.connectionId, message.prefix);
          await this.loadItems();
          this.render();
          break;
        case 'navigateUp': {
          this.searchPattern = undefined;
          this.searchPrefix = undefined;
          this.singleFileKey = undefined;
          const parent = this.getParentPrefix();
          this.prefix = parent;
          this.items = [];
          this.nextToken = undefined;
          this.loading = false;
          this.render();
          this.onNavigate(this.connectionId, parent);
          await this.loadItems();
          this.render();
          break;
        }
        case 'goToPath': {
          const rawPath = message.path as string || '';
          if (!rawPath) break;
          await this.goToPath(rawPath);
          break;
        }
        case 'historyJump': {
          const conn = this.connectionManager.getConnection(message.connectionId as string);
          if (!conn) { vscode.window.showErrorMessage(t('msg_connNotFound')); break; }
          const key = message.key as string;
          const prefix = key.endsWith('/') ? key : getParentPrefixDir(key);
          const label = key.replace(/\/$/, '').split('/').pop() || '/';
          const panel = FolderBrowserPanel.create(
            this.connectionManager, message.connectionId as string, prefix, label,
            this.onNavigate, this.getHistoryRecords, true
          );
          if (!key.endsWith('/')) panel.goToPath(key);
          break;
        }
        case 'delete': {
          const conn = this.connectionManager.getConnection(this.connectionId);
          if (!conn) return;
          const item = message.item as S3ObjectInfo;
          const name = item.key.split('/').pop() || item.key;
          const deleteBtn = t('msg_deleteBtn');
          const msgKey = item.isFolder ? 'msg_deleteFolderConfirm' : 'msg_deleteConfirm';
          const confirmed = await vscode.window.showWarningMessage(
            t(msgKey, name),
            { modal: true },
            deleteBtn
          );
          if (confirmed !== deleteBtn) return;
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
            title: t(item.isFolder ? 'prompt_rename_folder' : 'prompt_rename_file'),
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
            vscode.window.showErrorMessage(t('msg_renameFailed', err.message));
          }
          break;
        }
        case 'deleteSelected': {
          const conn = this.connectionManager.getConnection(this.connectionId);
          if (!conn) return;
          const items = message.items as { key: string; isFolder: boolean }[];
          if (!items || items.length === 0) break;
          const deleteBtn = t('msg_deleteBtn');
          const confirmed = await vscode.window.showWarningMessage(
            t('msg_deleteMultiConfirm', items.length),
            { modal: true },
            deleteBtn
          );
          if (confirmed !== deleteBtn) return;
          const client = createClient(conn);
          let failCount = 0;
          await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: t('msg_deleting', items.length) },
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
          vscode.window.setStatusBarMessage(`$(link) ${t('msg_copiedPath', item.key)}`, 3000);
          break;
        }
        case 'info': {
          const conn = this.connectionManager.getConnection(this.connectionId);
          if (!conn) return;
          const item = message.item as S3ObjectInfo;
          const client = createClient(conn);
          const { HeadObjectCommand } = await import('@aws-sdk/client-s3');
          const items: { label: string; value: string }[] = [
            { label: t('msg_infoKey'), value: item.key },
            { label: t('msg_infoType'), value: item.isFolder ? t('msg_infoFolder') : t('msg_infoFile') },
            { label: t('msg_infoSize'), value: item.size != null ? formatSize(item.size) : '-' },
            { label: t('msg_infoLastModified'), value: item.lastModified ? new Date(item.lastModified).toISOString() : '-' },
          ];
          try {
            const head = await client.send(new HeadObjectCommand({ Bucket: conn.bucket, Key: item.key }));
            if (head.ETag) items.push({ label: t('msg_infoETag'), value: head.ETag.replace(/"/g, '') });
            if (head.ContentType) items.push({ label: t('msg_infoContentType'), value: head.ContentType });
            if (head.ContentEncoding) items.push({ label: t('msg_infoContentEncoding'), value: head.ContentEncoding });
            if (head.StorageClass) items.push({ label: t('msg_infoStorageClass'), value: head.StorageClass });
            if (head.VersionId) items.push({ label: t('msg_infoVersionId'), value: head.VersionId });
            if (head.ContentDisposition) items.push({ label: t('msg_infoContentDisposition'), value: head.ContentDisposition });
            if (head.CacheControl) items.push({ label: t('msg_infoCacheControl'), value: head.CacheControl });
            if (head.ServerSideEncryption) items.push({ label: t('msg_infoEncryption'), value: head.ServerSideEncryption });
            if (head.SSEKMSKeyId) items.push({ label: t('msg_infoKmsKeyId'), value: head.SSEKMSKeyId });
            if (head.WebsiteRedirectLocation) items.push({ label: t('msg_infoWebsiteRedirect'), value: head.WebsiteRedirectLocation });
            if (head.Metadata && Object.keys(head.Metadata).length > 0) {
              for (const [k, v] of Object.entries(head.Metadata)) {
                items.push({ label: t('msg_infoMetadata', k), value: v || '' });
              }
            }
          } catch { /* use basic info */ }
          const picks = items.map(i => ({
            label: i.label,
            description: i.value,
          }));
          const pick = await vscode.window.showQuickPick(picks, {
            title: t('msg_infoTitle', item.key),
            placeHolder: t('msg_bucketInfoPlaceholder'),
            matchOnDescription: true,
          });
          if (pick) {
            vscode.env.clipboard.writeText(pick.description || '');
            vscode.window.setStatusBarMessage(`$(link) ${t('msg_copiedPath', pick.description)}`, 2000);
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
            { location: vscode.ProgressLocation.Notification, title: t('msg_downloading', item.key) },
            () => downloadFile(client, conn.bucket, item.key, uri.fsPath)
          );
          break;
        }
        case 'refresh':
          this.searchPattern = undefined;
          this.searchPrefix = undefined;
          this.refreshing = true;
          this.loading = false;
          if (this.singleFileKey) {
            this.render();
            await vscode.window.withProgress(
              { location: vscode.ProgressLocation.Window, title: t('msg_refreshing') },
              async () => {
                const conn = this.connectionManager.getConnection(this.connectionId);
                if (!conn) return;
                const client = createClient(conn);
                const { HeadObjectCommand } = await import('@aws-sdk/client-s3');
                try {
                  const head = await client.send(new HeadObjectCommand({ Bucket: conn.bucket, Key: this.singleFileKey! }));
                  this.items = [{ key: this.singleFileKey!, isFolder: false, size: head.ContentLength, lastModified: head.LastModified }];
                } catch {
                  vscode.window.showInformationMessage(t('msg_fileNoLongerExists', this.singleFileKey!));
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
              { location: vscode.ProgressLocation.Window, title: t('msg_refreshing') },
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
            title: t('msg_uploadTitle', this.prefix || '/'),
          });
          if (!uris || uris.length === 0) return;
          const client = createClient(conn);
          let successCount = 0;
          let failCount = 0;
          await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Window, title: t('msg_uploading', uris.length) },
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
                  vscode.window.showErrorMessage(t('msg_uploadFailed', fileName, err.message));
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
            vscode.window.showWarningMessage(t('msg_uploadWarn', successCount, failCount));
          } else if (successCount > 0 && failCount === 0) {
            vscode.window.showInformationMessage(t('msg_uploaded', successCount));
          }
          break;
        }
        case 'searchFiles': {
          const pattern = message.pattern as string;
          const mode = message.mode as string || 'prefix';
          if (!pattern) break;
          if (pattern.includes('/')) {
            this.searchPattern = undefined;
            this.searchPrefix = undefined;
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
                vscode.window.showInformationMessage(t('msg_fileNotFound', fullKey));
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
            if (mode === 'prefix') {
              this.searchPrefix = this.prefix + pattern;
            } else {
              this.searchPrefix = undefined;
            }
            this.items = [];
            this.nextToken = undefined;
            this.render();
            await vscode.window.withProgress(
              { location: vscode.ProgressLocation.Notification, title: t('msg_searching', pattern) },
              async () => {
                if (mode === 'prefix') {
                  await this.loadAllSearchPages();
                } else {
                  await this.loadAllFuzzySearchPages();
                }
              }
            );
            if (this.items.length === 0) {
              vscode.window.showInformationMessage(t('msg_searchNoResults'));
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
          const files = message.files as { fileName: string; content: string }[];
          if (!files || files.length === 0) break;
          const client = createClient(conn);
          let successCount = 0;
          let failCount = 0;
          await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Window, title: t('msg_uploading', files.length) },
            async (progress) => {
              for (let i = 0; i < files.length; i++) {
                const { fileName, content } = files[i];
                const key = this.prefix + fileName;
                progress.report({ message: `${i + 1}/${files.length} ${fileName}`, increment: Math.round(100 / files.length) });
                try {
                  const buffer = Buffer.from(content, 'base64');
                  const { PutObjectCommand } = await import('@aws-sdk/client-s3');
                  await client.send(new PutObjectCommand({ Bucket: conn.bucket, Key: key, Body: buffer }));
                  successCount++;
                } catch (err: any) {
                  failCount++;
                  vscode.window.showErrorMessage(t('msg_uploadFailed', fileName, err.message));
                }
              }
            }
          );
          if (successCount > 0) {
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
          }
          if (failCount > 0 && successCount > 0) {
            vscode.window.showWarningMessage(t('msg_uploadWarn', successCount, failCount));
          } else if (successCount > 0 && failCount === 0) {
            vscode.window.showInformationMessage(t('msg_uploaded', successCount));
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
    this.onNavigate(this.connectionId, targetFile ? rawPath : newPrefix);
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
        vscode.window.showInformationMessage(t('msg_fileNotFound', fullKey));
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
      const prefix = this.searchPrefix ?? this.prefix;
      const result = await listObjects(client, conn.bucket, prefix, 1, undefined, this.nextToken, 1000);
      this.items.push(...result.items);
      this.nextToken = result.nextToken;
    } finally {
      this.loading = false;
    }
  }

  private async loadAllSearchPages(): Promise<void> {
    if (this.loading) return;
    this.loading = true;
    try {
      const conn = this.connectionManager.getConnection(this.connectionId);
      if (!conn) return;

      const client = createClient(conn);
      const result = await listObjects(client, conn.bucket, this.searchPrefix, 1);
      this.items = result.items;
      this.nextToken = result.nextToken;
    } finally {
      this.loading = false;
    }
  }

  private async loadAllFuzzySearchPages(): Promise<void> {
    if (this.loading) return;
    this.loading = true;
    try {
      const conn = this.connectionManager.getConnection(this.connectionId);
      if (!conn) return;

      const client = createClient(conn);
      const lower = this.searchPattern!.toLowerCase();

      let cursor: string | undefined;
      for (let i = 0; i < 50; i++) {
        if (this.items.length > 0) break;
        const result = await listObjects(client, conn.bucket, this.prefix, 1, undefined, cursor, 1000);
        const matched = result.items.filter(i => i.key.replace(/\/$/, '').split('/').pop()?.toLowerCase().includes(lower));
        this.items.push(...matched);
        cursor = result.nextToken;
        if (!cursor) break;
      }
      this.nextToken = cursor;
    } finally {
      this.loading = false;
    }
  }

  private render(): void {
    const displayPath = this.singleFileKey || this.prefix || '/';
    this.panel.title = `${this.searchPrefix ? '🔍 ' + this.searchPrefix : displayPath} — ${this.connectionName}`;
    const records = this.getHistoryRecords?.() || [];
    this.panel.webview.html = getHtml(
      displayPath,
      this.items,
      this.nextToken !== undefined,
      this.loading || this.refreshing,
      this.refreshing,
      this.searchPattern,
      records,
      this.connectionId,
      FolderBrowserPanel.folderIcon,
      FolderBrowserPanel.fileIcon,
      FolderBrowserPanel.extIcons,
      FolderBrowserPanel.actionIcons,
      FolderBrowserPanel.backIcon,
    );
  }
}

function getParentPrefixDir(key: string): string {
  const normalized = key.replace(/\/$/, '');
  const lastSlash = normalized.lastIndexOf('/');
  if (lastSlash === -1) return '';
  return normalized.substring(0, lastSlash + 1);
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

function getHtml(prefix: string, items: S3ObjectInfo[], hasMore: boolean, loading: boolean, refreshing: boolean = false, searchPattern?: string, historyRecords?: JumpRecord[], connectionId?: string, folderSvg?: string, fileSvg?: string, extIcons?: Record<string, string>, actionIcons?: Record<string, string>, backIcon?: string): string {
  const headerRow = `<div class="list-header">
    <span></span>
    <span></span>
    <span onclick="sortBy('name')">${t('wv_name')}<span class="sort-icon"></span></span>
    <span onclick="sortBy('size')">${t('wv_size')}<span class="sort-icon"></span></span>
    <span onclick="sortBy('date')">${t('wv_modified')}<span class="sort-icon"></span></span>
    <span>${t('wv_actions')}</span>
  </div>`;

  const backSvg = backIcon || '&#x2190;';
  const refreshSvg = (actionIcons && actionIcons['refresh']) || '&#x21BB;';
  const uploadSvg = (actionIcons && actionIcons['upload']) || '&#x2B06;';
  const iconInfo = (actionIcons && actionIcons['info']) || '&#x2139;';
  const iconRename = (actionIcons && actionIcons['rename']) || '&#x270F;';
  const iconDelete = (actionIcons && actionIcons['delete']) || '&#x1F5D1;';
  const iconCopy = (actionIcons && actionIcons['copypath']) || '&#x1F4CB;';
  const iconDownload = (actionIcons && actionIcons['download']) || '&#x2B07;';
  const folderIconSvg = folderSvg || '&#x1F4C1;';
  const fileIconSvg = fileSvg || '&#x1F4C4;';
  const folderRows = items.filter(i => i.isFolder).map(i => {
    const name = i.key.replace(/\/$/, '').split('/').pop() || '';
    const data = JSON.stringify(i).replace(/"/g, '&quot;');
    return `<div class="item folder" data-item="${data}">
      <input type="checkbox" class="item-cb">
      <span class="item-icon">${folderIconSvg}</span>
      <span class="item-name">${escapeHtml(name)}</span>
      <span class="item-meta"></span>
      <span class="item-date"></span>
      <span class="item-actions">
        <span class="action" data-action="info" title="${t('wv_info')}">${iconInfo}</span>
        <span class="action" data-action="rename" title="${t('wv_rename')}">${iconRename}</span>
        <span class="action" data-action="delete" title="${t('wv_delete')}">${iconDelete}</span>
        <span class="action" data-action="copyPath" title="${t('wv_copyPath')}">${iconCopy}</span>
      </span>
    </div>`;
  }).join('');

  const fileRows = items.filter(i => !i.isFolder).map(i => {
    const name = i.key.split('/').pop() || i.key;
    const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
    const icon = ext && extIcons && extIcons[ext] ? extIcons[ext] : fileIconSvg;
    const data = JSON.stringify(i).replace(/"/g, '&quot;');
    return `<div class="item file" data-item="${data}">
      <input type="checkbox" class="item-cb">
      <span class="item-icon">${icon}</span>
      <span class="item-name">${escapeHtml(name)}</span>
      <span class="item-meta">${formatSize(i.size)}</span>
      <span class="item-date">${i.lastModified ? formatDate(new Date(i.lastModified)) : ''}</span>
      <span class="item-actions">
        <span class="action" data-action="info" title="${t('wv_info')}">${iconInfo}</span>
        <span class="action" data-action="rename" title="${t('wv_rename')}">${iconRename}</span>
        <span class="action" data-action="download" title="${t('wv_download')}">${iconDownload}</span>
        <span class="action" data-action="delete" title="${t('wv_delete')}">${iconDelete}</span>
        <span class="action" data-action="copyPath" title="${t('wv_copyPath')}">${iconCopy}</span>
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
  padding: 0;
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size);
  color: var(--vscode-foreground);
  background: var(--vscode-editor-background);
  display: flex;
  flex-direction: column;
  height: 100vh;
  overflow: hidden;
}
.top-section {
  padding: 12px 16px 0 16px;
  flex-shrink: 0;
}
.content-section {
  flex: 1;
  overflow-y: auto;
  padding: 0 16px 12px 16px;
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
  padding: 2px 6px;
  border-radius: 4px;
  display: flex;
  align-items: center;
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
  padding: 2px 6px;
  border-radius: 3px;
  opacity: 0.7;
  display: flex;
  align-items: center;
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
.item-icon { font-size: 15px; text-align: center; display: flex; align-items: center; justify-content: center; height: 100%; }
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
.action::after {
  content: attr(title);
  position: absolute;
  bottom: -28px;
  left: 50%;
  transform: translateX(-50%);
  background: var(--vscode-editorWidget-background, #333);
  color: var(--vscode-editorWidget-foreground, #fff);
  font-size: 11px;
  padding: 2px 6px;
  border-radius: 3px;
  white-space: nowrap;
  pointer-events: none;
  opacity: 0;
  transition: opacity 0.15s;
  z-index: 999;
}
.action {
  position: relative;
}
.action:hover::after { opacity: 1; }
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
.cm-item svg { vertical-align: middle; margin-right: 4px; }
.cm-sep {
  height: 1px;
  margin: 4px 8px;
  background: var(--vscode-menu-separatorBackground);
}
.history-dropdown {
  display: none;
  position: absolute;
  top: 100%;
  left: 0;
  right: 0;
  z-index: 100;
  max-height: 300px;
  overflow-y: auto;
  background: var(--vscode-dropdown-background, var(--vscode-menu-background));
  border: 1px solid var(--vscode-dropdown-border, var(--vscode-menu-border));
  border-radius: 4px;
  box-shadow: 0 4px 12px rgba(0,0,0,0.25);
  margin-top: 2px;
}
.history-dropdown.show { display: block; }
.history-item {
  padding: 7px 12px;
  cursor: pointer;
  border-bottom: 1px solid var(--vscode-dropdown-border, transparent);
}
.history-item:last-child { border-bottom: none; }
.history-item:hover,
.history-item.active {
  background: var(--vscode-list-activeSelectionBackground);
  color: var(--vscode-list-activeSelectionForeground);
}
.history-item .hi-path {
  font-size: 13px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.history-item .hi-conn {
  font-size: 11px;
  opacity: 0.7;
  margin-top: 1px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.history-item:hover .hi-conn,
.history-item.active .hi-conn {
  opacity: 0.9;
}
.header { position: relative; }
.search-mode {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 8px;
}
.search-mode select {
  background: var(--vscode-dropdown-background);
  color: var(--vscode-dropdown-foreground);
  border: 1px solid var(--vscode-dropdown-border);
  border-radius: 3px;
  padding: 5px 6px;
  font-size: 13px;
  outline: none;
  line-height: 1.3;
}
.search-mode select:focus {
  border-color: var(--vscode-focusBorder);
}
.search-mode .filter-input {
  margin-bottom: 0;
  flex: 1;
}
</style>
</head>
<body>
<div class="drag-overlay" id="dragOverlay">${t('wv_dropUpload')}</div>
<div class="top-section">
<div class="header">
  <button class="back-btn" id="backBtn" ${!prefix ? 'disabled' : ''}>${backSvg}</button>
  <input class="path-input" id="pathInput" value="${escapeHtml(prefix || '/')}" title="${t('wv_pathInputTitle')}">
  <button class="icon-btn" id="refreshBtn" ${refreshing ? 'disabled' : ''}>${refreshSvg}</button>
  <button class="icon-btn" id="uploadBtn">${uploadSvg}</button>
  <div class="history-dropdown" id="historyDropdown"></div>
</div>
<div class="sel-bar" id="selBar">
  <span class="count" id="selCount" data-format="${t('wv_selected')}">${t('wv_selected', '0')}</span>
  <button class="del-btn" id="delSelectedBtn">${t('wv_deleteSelected')}</button>
</div>
<div class="search-mode">
  <select id="searchModeSelect">
    <option value="prefix">${t('wv_searchPrefix')}</option>
    <option value="fuzzy">${t('wv_searchFuzzy')}</option>
  </select>
  <input class="filter-input" id="filterInput" type="text" placeholder="${t('wv_filterPlaceholder')}" value="${searchPattern ? escapeHtml(searchPattern) : ''}"${searchPattern ? ' data-searching="1"' : ''} autocomplete="off">
</div>
${headerRow}
</div>
<div class="content-section" id="contentSection">
${emptyState}
${allRows}
${loadMoreBtn}
</div>
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
    tooLarge: t('msg_tooLarge'),
  })};
  const actionIcons2 = ${JSON.stringify(actionIcons || {})};

let sortCol = '';
let sortDir = 1;
function sortBy(col) {
  if (sortCol === col) sortDir *= -1; else { sortCol = col; sortDir = 1; }
  const container = document.getElementById('contentSection');
  const items = Array.from(document.querySelectorAll('.item'));
  const loadMoreBtn = document.getElementById('loadMoreBtn');
  const refNode = loadMoreBtn || null;
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
  const addItem = (icon, text, action) => {
    const div = document.createElement('div');
    div.className = 'cm-item';
    div.innerHTML = icon + ' ' + text;
    div.addEventListener('click', () => { ctxMenu.classList.remove('show'); vscodeApi.postMessage({ type: action, item }); });
    ctxMenu.appendChild(div);
  };
  const ai = actionIcons2 || {};
  addItem(ai['info'] || '&#x2139;', l10n.info, 'info');
  addItem(ai['rename'] || '&#x270F;', l10n.rename, 'rename');
  if (isFile) addItem(ai['download'] || '&#x2B07;', l10n.download, 'download');
  addItem(ai['delete'] || '&#x1F5D1;', l10n.delete, 'delete');
  addItem(ai['copypath'] || '&#x1F4CB;', l10n.copyPath, 'copyPath');
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
  const tasks = [];
  for (const file of files) {
    if (file.size > maxSize) {
      vscodeApi.postMessage({ type: 'showError', text: l10n.tooLarge.replace('{0}', file.name) });
      continue;
    }
    tasks.push(new Promise(resolve => {
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result;
        resolve({ fileName: file.name, content: dataUrl.split(',')[1] });
      };
      reader.readAsDataURL(file);
    }));
  }
  const fileData = await Promise.all(tasks);
  if (fileData.length > 0) {
    vscodeApi.postMessage({ type: 'uploadDrop', files: fileData });
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
const searchModeSelect = document.getElementById('searchModeSelect');
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
    const mode = searchModeSelect ? searchModeSelect.value : 'prefix';
    vscodeApi.postMessage({ type: 'searchFiles', pattern: val, mode: mode });
  } else if (e.key === 'Escape') {
    filterInput.value = '';
    filterInput.blur();
    if (filterInput.dataset.searching) {
      filterInput.dataset.searching = '';
      vscodeApi.postMessage({ type: 'refresh' });
    }
  }
});
// --- jump history autocomplete ---
const historyRecords = ${JSON.stringify(historyRecords || [])};
const currentConnectionId = ${JSON.stringify(connectionId || '')};

// deduplicate by connectionId+key (keep most recent), then sort by time desc
const seen = new Map();
historyRecords.forEach(r => {
  const key = r.connectionId + '\\x00' + r.key;
  const existing = seen.get(key);
  if (!existing || r.timestamp > existing.timestamp) seen.set(key, r);
});
const dedupedRecords = Array.from(seen.values()).sort((a, b) => b.timestamp - a.timestamp);

const pathInput = document.getElementById('pathInput');
const dropdown = document.getElementById('historyDropdown');
let activeIdx = -1;
let debounceTimer = null;

function closeDropdown() {
  dropdown.classList.remove('show');
  dropdown.innerHTML = '';
  activeIdx = -1;
}

function renderDropdown(results) {
  if (results.length === 0) { closeDropdown(); return; }
  dropdown.innerHTML = results.map((r, i) =>
    '<div class="history-item' + (i === activeIdx ? ' active' : '') + '" data-idx="' + i + '">' +
      '<div class="hi-path">' + escapeHtml(r.key) + '</div>' +
      '<div class="hi-conn">' + escapeHtml(r.connectionName) + '</div>' +
    '</div>'
  ).join('');
  dropdown.classList.add('show');
  const el = dropdown.querySelector('.history-item.active');
  if (el) el.scrollIntoView({ block: 'nearest' });
}

function filterHistory(query) {
  const q = query.toLowerCase();
  return dedupedRecords.filter(r => r.connectionId === currentConnectionId && r.key.toLowerCase().includes(q));
}

function selectHistoryItem(idx) {
  const results = filterHistory(pathInput.value);
  if (idx < 0 || idx >= results.length) return;
  const r = results[idx];
  closeDropdown();
  pathInput.value = r.key;
  if (r.connectionId === currentConnectionId) {
    vscodeApi.postMessage({ type: 'goToPath', path: r.key });
  } else {
    vscodeApi.postMessage({ type: 'historyJump', connectionId: r.connectionId, key: r.key });
  }
}

pathInput?.addEventListener('input', () => {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    const results = filterHistory(pathInput.value);
    renderDropdown(results);
  }, 100);
});

pathInput?.addEventListener('focus', () => {
  const results = filterHistory(pathInput.value);
  renderDropdown(results);
});

pathInput?.addEventListener('blur', () => {
  setTimeout(closeDropdown, 150);
});

pathInput?.addEventListener('keydown', e => {
  if (e.isComposing) return;
  const results = filterHistory(pathInput.value);
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    activeIdx = Math.min(activeIdx + 1, results.length - 1);
    renderDropdown(results);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    activeIdx = Math.max(activeIdx - 1, -1);
    renderDropdown(results);
  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (activeIdx >= 0 && activeIdx < results.length) {
      selectHistoryItem(activeIdx);
    } else {
      closeDropdown();
      vscodeApi.postMessage({ type: 'goToPath', path: pathInput.value });
    }
  } else if (e.key === 'Escape') {
    closeDropdown();
  }
});

dropdown?.addEventListener('mousedown', e => {
  const item = e.target.closest('.history-item');
  if (!item) return;
  e.preventDefault();
  const idx = parseInt(item.dataset.idx);
  selectHistoryItem(idx);
});

function escapeHtml(text) {
  const div = document.createElement('div');
  div.appendChild(document.createTextNode(text));
  return div.innerHTML;
}
// --- end jump history autocomplete ---
document.getElementById('refreshBtn')?.addEventListener('click', () => {
  vscodeApi.postMessage({ type: 'refresh' });
});
</script>
</body>
</html>`;
}
