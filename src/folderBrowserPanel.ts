import * as vscode from 'vscode';
import * as os from "os";
import * as path from 'path';
import * as fs from 'fs';
import * as stream from 'stream';
import { createClient, listObjects, uploadFile, downloadFile, downloadFolder, deleteObject, deleteFolder, renameObject, renameFolder, createFolder, S3ObjectInfo, ProgressFn } from './s3Client';
import { taskManager } from './taskManager';
import { TaskViewPanel } from './taskViewPanel';
import { ConnectionManager } from './connectionManager';
import { JumpRecord } from './jumpHistory';
import { t } from './i18n';

export class FolderBrowserPanel {
  static pendingChunkTransfers: Map<string, {
    fileName: string;
    totalChunks: number;
    receivedChunks: number;
    taskId: string;
    progress?: { report: (v: { message?: string; increment?: number }) => void };
    progressResolve?: () => void;
    passThrough?: stream.PassThrough;
    uploadDone?: Promise<void>;
    tempFile?: string;
  }> | undefined;
  private static readonly CHUNK_SIZE = 5 * 1024 * 1024;

  public static create(
    connectionManager: ConnectionManager,
    connectionId: string,
    prefix: string,
    label: string,
    onNavigate: (connectionId: string, prefix: string) => void,
    getHistoryRecords?: () => JumpRecord[],
    skipInitialLoad = false
  ): FolderBrowserPanel {
    // Close task view when opening a connection
    TaskViewPanel.currentPanel?.dispose();
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
  private searchMode: string = 'prefix';
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
        case 'downloadSelected': {
          const conn = this.connectionManager.getConnection(this.connectionId);
          if (!conn) return;
          const items = message.items as { key: string; isFolder: boolean }[];
          if (!items || items.length === 0) break;
          const files = items.filter(i => !i.isFolder);
          if (files.length === 0) {
            vscode.window.showInformationMessage(t('msg_downloadSelectedNoFiles'));
            break;
          }
          const uris = await vscode.window.showOpenDialog({
            canSelectFolders: true,
            canSelectMany: false,
            title: t('msg_downloadSelectedTitle', files.length),
          });
          if (!uris || uris.length === 0) return;
          const destDir = uris[0].fsPath;
          const client = createClient(conn);
          let successCount = 0;
          let failCount = 0;
          await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: t('msg_downloadingMany', files.length) },
            async (progress) => {
              for (let i = 0; i < files.length; i++) {
                const fileName = files[i].key.split('/').pop() || files[i].key;
                progress.report({ message: `${i + 1}/${files.length} ${fileName}` });
                try {
                  const destPath = path.join(destDir, fileName);
                  const fileName3 = files[i].key.split('/').pop() || files[i].key;
                  const taskId = taskManager.add({
                    type: 'download',
                    fileName: fileName3,
                    size: files[i].size || 0,
                    source: `${conn.bucket}/${files[i].key}`,
                    destination: destPath,
                    connectionName: conn.name,
                    bucket: conn.bucket,
                  });
                  await downloadFile(client, conn.bucket, files[i].key, destPath, (pct) => {
                    taskManager.updateProgress(taskId, pct);
                  });
                  taskManager.complete(taskId);
                  successCount++;
                } catch (err: any) {
                  failCount++;
                  vscode.window.showErrorMessage(t('msg_downloadFailed', `${fileName}: ${err.message}`));
                }
              }
            }
          );
          if (failCount > 0 && successCount > 0) {
            vscode.window.showWarningMessage(t('msg_downloadedWarn', successCount, failCount));
          } else if (successCount > 0 && failCount === 0) {
            vscode.window.showInformationMessage(t('msg_downloadedMany', successCount, destDir));
          }
          break;
        }
        case 'copyPath': {
          const item = message.item as S3ObjectInfo;
          vscode.env.clipboard.writeText(item.key);
          vscode.window.setStatusBarMessage(`$(link) ${t('msg_copiedPath', item.key)}`, 3000);
          break;
        }
        case 'copyFileName': {
          const item = message.item as S3ObjectInfo;
          const fileName = item.key.split('/').pop() || item.key;
          vscode.env.clipboard.writeText(fileName);
          vscode.window.setStatusBarMessage(`$(link) ${t('msg_copiedFileName', fileName)}`, 3000);
          break;
        }
        case 'info': {
          const conn = this.connectionManager.getConnection(this.connectionId);
          if (!conn) return;
          const item = message.item as S3ObjectInfo;
          const client = createClient(conn);
          const { HeadObjectCommand } = await import('@aws-sdk/client-s3');
          const { getFolderInfo } = await import('./s3Client');
          const items: { label: string; value: string }[] = [
            { label: t('msg_infoKey'), value: item.key },
            { label: t('msg_infoType'), value: item.isFolder ? t('msg_infoFolder') : t('msg_infoFile') },
            { label: t('msg_infoSize'), value: item.size != null ? `${formatSize(item.size)} (${item.size.toLocaleString()} B)` : '-' },
            { label: t('msg_infoLastModified'), value: item.lastModified ? formatDate(new Date(item.lastModified)) : '-' },
          ];
          if (item.isFolder) {
            try {
              const info = await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: t('msg_gatheringFolderInfo') },
                () => getFolderInfo(client, conn.bucket, item.key)
              );
              items.push(
                { label: t('msg_infoTotalObjects'), value: info.totalObjects >= 200000 ? '200000+' : String(info.totalObjects) },
                { label: t('msg_infoTotalSize'), value: formatSize(info.totalSize) },
              );
            } catch {}
          }
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
          const client = createClient(conn);
          if (item.isFolder) {
            const uri = await vscode.window.showOpenDialog({
              canSelectFolders: true,
              canSelectMany: false,
              title: t('msg_downloadFolderTitle', item.key),
            });
            if (!uri || uri.length === 0) return;
            const destDir = path.join(uri[0].fsPath, item.key.replace(/\/$/, '').split('/').pop() || 'folder');
            this._downloadItem(item, client, conn, destDir);
          } else {
            const defaultUri = vscode.Uri.file(path.join(os.homedir(), item.key.split('/').pop() || item.key));
            const uri = await vscode.window.showSaveDialog({ defaultUri });
            if (!uri) return;
            this._downloadItem(item, client, conn, uri.fsPath);
          }
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
        case 'newFolder': {
          const conn = this.connectionManager.getConnection(this.connectionId);
          if (!conn) break;
          const folderName = await vscode.window.showInputBox({
            title: t('prompt_newFolderName'),
            placeHolder: t('prompt_newFolder_placeholder'),
            ignoreFocusOut: true,
            validateInput: (val) => {
              if (!val) return t('val_empty');
              if (val.includes('/')) return t('val_slash');
              return undefined;
            },
          });
          if (!folderName) break;
          const client = createClient(conn);
          await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: t('msg_creatingFolder') },
            async () => {
              try {
                await createFolder(client, conn.bucket, this.prefix + folderName);
                this.items = [];
                this.nextToken = undefined;
                this.loading = false;
                await this.loadItems();
                this.render();
                vscode.window.showInformationMessage(t('msg_folderCreated', folderName));
              } catch (err: any) {
                vscode.window.showErrorMessage(t('msg_folderFailed', err.message));
              }
            }
          );
          break;
        }
        case 'upload': {
          const conn = this.connectionManager.getConnection(this.connectionId);
          if (!conn) return;
          const mode = await vscode.window.showQuickPick(
            [
              { label: t('wv_uploadFiles'), description: '' },
              { label: t('wv_uploadFolder'), description: '' },
            ],
            { placeHolder: t('msg_uploadTitle', this.prefix || '/') }
          );
          if (!mode) return;
          let uris: vscode.Uri[] | undefined;
          if (mode.label === t('wv_uploadFolder')) {
            uris = await vscode.window.showOpenDialog({
              canSelectFolders: true,
              canSelectMany: false,
              title: t('msg_uploadFolderTitle', this.prefix || '/'),
            });
          } else {
            uris = await vscode.window.showOpenDialog({
              canSelectMany: true,
              title: t('msg_uploadTitle', this.prefix || '/'),
            });
          }
          if (!uris || uris.length === 0) return;
          const client = createClient(conn);
          
          // Start upload in background so the panel stays responsive
          this._uploadFiles(conn, client, uris);
          break;
        }
        case 'searchFiles': {
          const pattern = message.pattern as string;
          const mode = message.mode as string || 'prefix';
          this.searchMode = mode;
          if (!pattern) break;
          if (pattern.includes('/')) {
            this.searchPattern = undefined;
            this.searchPrefix = undefined;
            const trimmed = pattern.replace(/\/$/, '');
            const lastSlash = trimmed.lastIndexOf('/');
            const lastSegment = lastSlash === -1 ? pattern : trimmed.substring(lastSlash + 1);
            if (pattern.endsWith('/')) {
              this.singleFileKey = undefined;
              this.prefix = pattern;
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
                this.singleFileKey = undefined;
                this.prefix = pattern.endsWith('/') ? pattern : pattern + '/';
                this.items = [];
                this.nextToken = undefined;
                this.loading = false;
                this.render();
                await this.loadItems();
                this.render();
              }
            }
          } else {
            this.singleFileKey = undefined;
            this.searchPattern = pattern;
            if (mode === 'prefix' || mode === 'exact') {
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
                } else if (mode === 'exact') {
                  await this.loadAllExactSearchPages();
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
                const taskId = taskManager.add({
                  type: 'upload',
                  fileName,
                  source: key,
                  destination: `${conn.bucket}/${key}`,
                  connectionName: conn.name,
                  bucket: conn.bucket,
                });
                try {
                  const buffer = Buffer.from(content, 'base64');
                  const { PutObjectCommand } = await import('@aws-sdk/client-s3');
                  await client.send(new PutObjectCommand({ Bucket: conn.bucket, Key: key, Body: buffer }));
                  taskManager.complete(taskId);
                  successCount++;
                } catch (err: any) {
                  taskManager.fail(taskId, err.message);
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
        case 'uploadDropChunk': {
          const conn2 = this.connectionManager.getConnection(this.connectionId);
          if (!conn2) break;
          const { transferId, fileName, chunk, chunkIndex, totalChunks, fileSize } = message as any;
          if (!transferId || !fileName) break;

          if (!FolderBrowserPanel.pendingChunkTransfers) {
            FolderBrowserPanel.pendingChunkTransfers = new Map();
          }
          const transfers = FolderBrowserPanel.pendingChunkTransfers;

          let transfer = transfers.get(transferId);
          if (!transfer) {
            const taskId = taskManager.add({
              type: 'upload',
              fileName,
              size: fileSize,
              source: fileName,
              destination: `${conn2.bucket}/${this.prefix}${fileName}`,
              connectionName: conn2.name,
              bucket: conn2.bucket,
            });

            if (!conn2.isHuaweiOBS) {
              const passThrough = new stream.PassThrough();
              const { Upload } = await import('@aws-sdk/lib-storage');
              const uploadClient = createClient(conn2);
              const upload = new Upload({
                client: uploadClient as any,
                params: { Bucket: conn2.bucket, Key: this.prefix + fileName, Body: passThrough },
                queueSize: 4,
                partSize: 1024 * 1024 * 16,
                leavePartsOnError: false,
              });
              upload.on('httpUploadProgress', (p: { loaded?: number; total?: number }) => {
                taskManager.updateProgress(taskId, Math.round((p.loaded ?? 0) / (p.total ?? fileSize) * 100));
              });
              transfer = { fileName, totalChunks, receivedChunks: 0, taskId, passThrough, uploadDone: upload.done() };
            } else {
              const tempDir = path.join(os.tmpdir(), 'vscode-s3-uploads');
              fs.mkdirSync(tempDir, { recursive: true });
              const tempFile = path.join(tempDir, transferId);
              fs.writeFileSync(tempFile, Buffer.alloc(0));
              transfer = { fileName, tempFile, totalChunks, receivedChunks: 0, taskId };
            }
            transfers.set(transferId, transfer);

            vscode.window.withProgress(
              { location: vscode.ProgressLocation.Window, title: t('msg_uploadTitle', fileName) },
              (p) => new Promise<void>(resolve => {
                transfer!.progress = p;
                transfer!.progressResolve = resolve;
              })
            );
          }

          const chunkBuf = Buffer.from(chunk);
          if (transfer.passThrough) {
            transfer.passThrough.write(chunkBuf);
          } else {
            const writeFd = await fs.promises.open(transfer.tempFile!, 'r+');
            await writeFd.write(chunkBuf, 0, chunkBuf.length, chunkIndex * FolderBrowserPanel.CHUNK_SIZE);
            await writeFd.close();
          }
          transfer.receivedChunks++;

          const pct = Math.round(transfer.receivedChunks / totalChunks * 100);
          transfer.progress?.report({ increment: 100 / totalChunks, message: `${pct}% (${transfer.receivedChunks}/${totalChunks})` });

          if (transfer.receivedChunks >= totalChunks) {
            transfer.progress?.report({ message: fileName + ' - ' + t('msg_uploading', 1) });
            const client = createClient(conn2);
            try {
              if (transfer.passThrough) {
                transfer.passThrough.end();
                await transfer.uploadDone;
              } else {
                await uploadFile(client, conn2.bucket, this.prefix + fileName, transfer.tempFile!, undefined, (pct) => {
                  taskManager.updateProgress(transfer.taskId, pct);
                });
              }
              taskManager.complete(transfer.taskId);
            } catch (err: any) {
              taskManager.fail(transfer.taskId, err.message);
            } finally {
              transfer.progressResolve?.();
              transfers.delete(transferId);
              if (transfer.tempFile) {
                try { fs.unlinkSync(transfer.tempFile); } catch {}
              }
            }

            this.items = [];
            this.nextToken = undefined;
            this.loading = false;
            if (this.singleFileKey) {
              const { HeadObjectCommand } = await import('@aws-sdk/client-s3');
              try {
                const head = await client.send(new HeadObjectCommand({ Bucket: conn2.bucket, Key: this.singleFileKey }));
                this.items = [{ key: this.singleFileKey, isFolder: false, size: head.ContentLength, lastModified: head.LastModified }];
              } catch {
                this.singleFileKey = undefined;
              }
            } else {
              await this.loadItems();
            }
            this.render();
            vscode.window.showInformationMessage(t('msg_uploaded', 1));
          }
          break;
        }
        case 'uploadDropPath': {
          const conn4 = this.connectionManager.getConnection(this.connectionId);
          if (!conn4) break;
          const { fileName: pathFileName, filePath, fileSize: pathFileSize } = message as any;
          if (!pathFileName || !filePath) break;
          const pathTaskId = taskManager.add({
            type: 'upload',
            fileName: pathFileName,
            size: pathFileSize,
            source: filePath,
            destination: `${conn4.bucket}/${this.prefix}${pathFileName}`,
            connectionName: conn4.name,
            bucket: conn4.bucket,
          });
          try {
            const pathClient = createClient(conn4);
            await uploadFile(pathClient, conn4.bucket, this.prefix + pathFileName, filePath, undefined, (pct) => {
              taskManager.updateProgress(pathTaskId, pct);
            });
            taskManager.complete(pathTaskId);
          } catch (err: any) {
            taskManager.fail(pathTaskId, err.message);
          }
          break;
        }
        case 'openTaskView': {
          TaskViewPanel.createOrShow();
          break;
        }
      }
    });
  }

  
  private async _downloadItem(item: any, client: any, conn: any, destPath: string): Promise<void> {
    const fileName = item.key.split('/').pop() || item.key;
    const taskId = taskManager.add({
      type: 'download',
      fileName,
      size: item.size || 0,
      source: `${conn.bucket}/${item.key}`,
      destination: destPath,
      connectionName: conn.name,
      bucket: conn.bucket,
    });
    try {
      if (item.isFolder) {
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: t('msg_downloadingFolder', item.key) },
          async (progress) => {
            const result = await downloadFolder(client, conn.bucket, item.key, destPath, (current, total) => {
              const pct = total > 0 ? Math.round(current / total * 100) : 0;
              taskManager.updateProgress(taskId, pct);
              progress.report({ message: `${current}/${total}` });
            });
            if (result.fail > 0 && result.success > 0) {
              vscode.window.showWarningMessage(t('msg_downloadedWarn', result.success, result.fail));
            } else if (result.success > 0) {
              vscode.window.showInformationMessage(t('msg_downloadedFolder', result.success, destPath));
            }
            if (result.fail > 0) {
              taskManager.fail(taskId, t('msg_downloadedWarn', result.success, result.fail));
            } else {
              taskManager.complete(taskId);
            }
          }
        );
      } else {
        await downloadFile(client, conn.bucket, item.key, destPath, (pct) => {
          taskManager.updateProgress(taskId, pct);
        });
        taskManager.complete(taskId);
      }
    } catch (err: any) {
      taskManager.fail(taskId, err.message);
    }
  }

  private async _uploadFiles(conn: any, client: any, uris: vscode.Uri[]): Promise<void> {
    let successCount = 0;
    let failCount = 0;
    const allFiles: { localPath: string; remoteKey: string }[] = [];
    for (const uri of uris) {
      const stat = fs.statSync(uri.fsPath);
      if (stat.isDirectory()) {
        const baseName = path.basename(uri.fsPath);
        const files = walkDir(uri.fsPath);
        for (const f of files) {
          const relative = path.relative(uri.fsPath, f);
          allFiles.push({ localPath: f, remoteKey: this.prefix + baseName + '/' + relative.replace(/\\/g, '/') });
        }
      } else {
        const fileName = path.basename(uri.fsPath);
        allFiles.push({ localPath: uri.fsPath, remoteKey: this.prefix + fileName });
      }
    }
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: t('msg_uploading', allFiles.length) },
      async (progress) => {
        for (let i = 0; i < allFiles.length; i++) {
          const { localPath, remoteKey } = allFiles[i];
          const fileName = path.basename(localPath);
          progress.report({ message: `${i + 1}/${allFiles.length} ${fileName}`, increment: Math.round(100 / allFiles.length) });
          const taskId = taskManager.add({
            type: 'upload',
            fileName,
            size: fs.statSync(localPath).size,
            source: localPath,
            destination: `${conn.bucket}/${remoteKey}`,
            connectionName: conn.name,
            bucket: conn.bucket,
          });
          try {
            await uploadFile(client, conn.bucket, remoteKey, localPath, undefined, (pct) => {
              taskManager.updateProgress(taskId, pct);
            });
            taskManager.complete(taskId);
            successCount++;
          } catch (err: any) {
            taskManager.fail(taskId, err.message);
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
        const cl = createClient(conn);
        try {
          const head = await cl.send(new HeadObjectCommand({ Bucket: conn.bucket, Key: this.singleFileKey }));
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
  }

public async goToPath(rawPath: string): Promise<void> {
    this.searchPattern = undefined;
    const conn = this.connectionManager.getConnection(this.connectionId);
    if (!conn) return;
    if (!rawPath) return;

    if (rawPath === '/') {
      this.prefix = '';
      this.singleFileKey = undefined;
      this.items = [];
      this.nextToken = undefined;
      this.loading = false;
      this.onNavigate(this.connectionId, '');
      this.render();
      await this.loadItems();
      this.render();
      return;
    }

    const trimmed = rawPath.replace(/\/$/, '');
    const isFolderInput = rawPath.endsWith('/');
    const lastSlash = trimmed.lastIndexOf('/');
    const lastSegment = lastSlash === -1 ? trimmed : trimmed.substring(lastSlash + 1);
    const parentPrefix = lastSlash === -1 ? '' : trimmed.substring(0, lastSlash + 1);

    const client = createClient(conn);
    const { HeadObjectCommand, ListObjectsV2Command } = await import('@aws-sdk/client-s3');

    const checkFolderExists = async (prefix: string): Promise<boolean> => {
      try {
        const resp = await client.send(new ListObjectsV2Command({
          Bucket: conn.bucket, Prefix: prefix, Delimiter: '/', MaxKeys: 1,
        }));
        return (resp.CommonPrefixes && resp.CommonPrefixes.length > 0)
          || (resp.Contents && resp.Contents.length > 0);
      } catch { return false; }
    };

    let fileExists = false;
    let fileHead: any = undefined;
    if (!isFolderInput) {
      try {
        fileHead = await client.send(new HeadObjectCommand({ Bucket: conn.bucket, Key: rawPath }));
        fileExists = true;
      } catch { /* file doesn't exist */ }
    }

    const folderKey = trimmed + '/';
    let folderExists = await checkFolderExists(folderKey);

    if (fileExists && folderExists) {
      this.singleFileKey = undefined;
      this.prefix = parentPrefix;
      this.items = [];
      this.nextToken = undefined;
      this.loading = false;
      this.onNavigate(this.connectionId, parentPrefix);
      this.render();
      await this.loadItems();
      this.items = this.items.filter(i => {
        const name = i.key.replace(/\/$/, '').split('/').pop()?.toLowerCase();
        return name === lastSegment.toLowerCase();
      });
      this.render();
      this.panel.webview.postMessage({ type: 'highlight', name: lastSegment });
    } else if (fileExists) {
      this.singleFileKey = rawPath;
      this.prefix = parentPrefix;
      this.items = [{ key: rawPath, isFolder: false, size: fileHead?.ContentLength, lastModified: fileHead?.LastModified }];
      this.nextToken = undefined;
      this.loading = false;
      this.onNavigate(this.connectionId, rawPath);
      this.render();
      this.panel.webview.postMessage({ type: 'highlight', name: lastSegment });
    } else if (folderExists) {
      this.singleFileKey = undefined;
      this.prefix = folderKey;
      this.items = [];
      this.nextToken = undefined;
      this.loading = false;
      this.onNavigate(this.connectionId, this.prefix);
      this.render();
      await this.loadItems();
      this.render();
    } else {
      // Walk up to find the nearest existing ancestor
      let segments = trimmed.split('/').filter(Boolean);
      let found = false;
      while (segments.length > 0) {
        segments.pop();
        const ancestorPrefix = segments.length > 0 ? segments.join('/') + '/' : '';
        if (ancestorPrefix === '' || await checkFolderExists(ancestorPrefix)) {
          this.singleFileKey = undefined;
          this.prefix = ancestorPrefix;
          this.items = [];
          this.nextToken = undefined;
          this.loading = false;
          this.onNavigate(this.connectionId, ancestorPrefix);
          this.render();
          await this.loadItems();
          this.render();
          if (ancestorPrefix) {
            vscode.window.showWarningMessage(t('msg_pathNotFound', rawPath));
          }
          found = true;
          break;
        }
      }
      if (!found) {
        // Navigate to root
        this.prefix = '';
        this.singleFileKey = undefined;
        this.items = [];
        this.nextToken = undefined;
        this.loading = false;
        this.onNavigate(this.connectionId, '');
        this.render();
        await this.loadItems();
        this.render();
        vscode.window.showWarningMessage(t('msg_pathNotFound', rawPath));
      }
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
      const result = await listObjects(client, conn.bucket, prefix, 1, undefined, this.nextToken, 100);
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
        const result = await listObjects(client, conn.bucket, this.prefix, 1, undefined, cursor, 100);
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

  private async loadAllExactSearchPages(): Promise<void> {
    if (this.loading) return;
    this.loading = true;
    try {
      const conn = this.connectionManager.getConnection(this.connectionId);
      if (!conn) return;

      const client = createClient(conn);
      const lower = this.searchPattern!.toLowerCase();
      this.searchPrefix = this.prefix + this.searchPattern;

      const result = await listObjects(client, conn.bucket, this.searchPrefix, 1);
      this.items = result.items.filter(i => {
        const name = i.key.replace(/\/$/, '').split('/').pop()?.toLowerCase();
        return name === lower;
      });
      this.nextToken = undefined;
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
      this.searchMode,
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
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes < 1024 * 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  return `${(bytes / (1024 * 1024 * 1024 * 1024)).toFixed(1)} TB`;
}

function formatDate(date?: Date): string {
  if (!date) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function walkDir(dir: string): string[] {
  const result: string[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      result.push(...walkDir(fullPath));
    } else {
      result.push(fullPath);
    }
  }
  return result;
}

function getHtml(prefix: string, items: S3ObjectInfo[], hasMore: boolean, loading: boolean, refreshing: boolean = false, searchPattern?: string, historyRecords?: JumpRecord[], connectionId?: string, folderSvg?: string, fileSvg?: string, extIcons?: Record<string, string>, actionIcons?: Record<string, string>, backIcon?: string, searchMode?: string): string {
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
  const newFolderSvg = (actionIcons && actionIcons['newfolder']) || '&#x1F4C1;';
  const iconInfo = (actionIcons && actionIcons['info']) || '&#x2139;';
  const iconRename = (actionIcons && actionIcons['rename']) || '&#x270F;';
  const iconDelete = (actionIcons && actionIcons['delete']) || '&#x1F5D1;';
  const iconCopy = (actionIcons && actionIcons['copypath']) || '&#x1F4CB;';
  const iconCopyName = (actionIcons && actionIcons['copyfilename']) || '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="2" y="1" width="9" height="11" rx="1.5" stroke="currentColor" stroke-width="1.2"/><rect x="4" y="7" width="5" height="1.5" rx="0.75" fill="currentColor"/><rect x="4" y="4.5" width="3.5" height="1.5" rx="0.75" fill="currentColor"/></svg>';
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
        <span class="action" data-action="download" title="${t('wv_download')}">${iconDownload}</span>
        <span class="action" data-action="rename" title="${t('wv_rename')}">${iconRename}</span>
        <span class="action" data-action="delete" title="${t('wv_delete')}">${iconDelete}</span>
        <span class="action" data-action="copyPath" title="${t('wv_copyPath')}">${iconCopy}</span>
        <span class="action" data-action="copyFileName" title="${t('wv_copyFileName')}">${iconCopyName}</span>
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
        <span class="action" data-action="copyFileName" title="${t('wv_copyFileName')}">${iconCopyName}</span>
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
  overflow-x: hidden;
  scrollbar-gutter: stable;
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
  position: relative;
}
.icon-btn:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground); }
.icon-btn:disabled { opacity: 0.3; cursor: default; }
.icon-btn:disabled:hover { opacity: 0.3; background: none; }
.icon-btn::after {
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
.icon-btn:hover::after { opacity: 1; }
.header-sep {
  width: 1px;
  height: 18px;
  background: var(--vscode-panel-border);
  margin: 0 4px;
  flex-shrink: 0;
}
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
.item-actions { display: flex; gap: 2px; opacity: 0; }
.item:hover .item-actions { opacity: 1; }
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
  <button class="icon-btn" id="refreshBtn" title="${t('wv_refresh')}" ${refreshing ? 'disabled' : ''}>${refreshSvg}</button>
  <button class="icon-btn" id="newFolderBtn" title="${t('cmd_newFolder')}">${newFolderSvg}</button>
  <button class="icon-btn" id="uploadBtn" title="${t('wv_upload')}">${uploadSvg}</button>
  <button class="icon-btn" id="taskViewBtn" title="${t('cmd_openTaskView')}">&#x2630;</button>
  <span class="header-sep"></span>
  <button class="icon-btn" id="dlBatchBtn" title="${t('wv_downloadSelected')}" disabled>${iconDownload}</button>
  <button class="icon-btn" id="delBatchBtn" title="${t('wv_deleteSelected')}" disabled>${iconDelete}</button>
  <div class="history-dropdown" id="historyDropdown"></div>
</div>
<div class="search-mode">
  <select id="searchModeSelect">
    <option value="prefix" ${searchMode === 'prefix' ? 'selected' : ''}>${t('wv_searchPrefix')}</option>
    <option value="fuzzy" ${searchMode === 'fuzzy' ? 'selected' : ''}>${t('wv_searchFuzzy')}</option>
    <option value="exact" ${searchMode === 'exact' ? 'selected' : ''}>${t('wv_searchExact')}</option>
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
  (() => {
    const pos = sessionStorage.getItem('scrollPos');
    if (pos) {
      sessionStorage.removeItem('scrollPos');
      requestAnimationFrame(() => {
        const section = document.querySelector('.content-section');
        if (section) section.scrollTop = Number(pos);
      });
    }
  })();
  const l10n = ${JSON.stringify({
    rename: t('wv_rename'),
    download: t('wv_download'),
    delete: t('wv_delete'),
    copyPath: t('wv_copyPath'),
    copyFileName: t('wv_copyFileName'),
    info: t('wv_info'),
    tooLarge: t('msg_tooLarge'),
    newFolder: t('cmd_newFolder'),
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
const dlBatchBtn = document.getElementById('dlBatchBtn');
const delBatchBtn = document.getElementById('delBatchBtn');

function getSelectedItems() {
  const checked = document.querySelectorAll('.item-cb:checked');
  return Array.from(checked).map(cb => JSON.parse(cb.closest('.item').dataset.item));
}

document.addEventListener('change', e => {
  const cb = e.target.closest('.item-cb');
  if (!cb) return;
  cb.closest('.item').classList.toggle('selected', cb.checked);
  dlBatchBtn.disabled = !document.querySelectorAll('.item-cb:checked').length;
  delBatchBtn.disabled = !document.querySelectorAll('.item-cb:checked').length;
});

dlBatchBtn.addEventListener('click', () => {
  if (dlBatchBtn.disabled) return;
  vscodeApi.postMessage({ type: 'downloadSelected', items: getSelectedItems() });
});

delBatchBtn.addEventListener('click', () => {
  if (delBatchBtn.disabled) return;
  vscodeApi.postMessage({ type: 'deleteSelected', items: getSelectedItems() });
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
  addItem(ai['download'] || '&#x2B07;', l10n.download, 'download');
  addItem(ai['rename'] || '&#x270F;', l10n.rename, 'rename');
  if (isFile) addItem(ai['download'] || '&#x2B07;', l10n.download, 'download');
  addItem(ai['delete'] || '&#x1F5D1;', l10n.delete, 'delete');
  addItem(ai['copypath'] || '&#x1F4CB;', l10n.copyPath, 'copyPath');
  addItem(ai['copyfilename'] || '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="2" y="1" width="9" height="11" rx="1.5" stroke="currentColor" stroke-width="1.2"/><rect x="4" y="7" width="5" height="1.5" rx="0.75" fill="currentColor"/><rect x="4" y="4.5" width="3.5" height="1.5" rx="0.75" fill="currentColor"/></svg>', l10n.copyFileName, 'copyFileName');
  ctxMenu.style.left = e.clientX + 'px';
  ctxMenu.style.top = e.clientY + 'px';
  ctxMenu.classList.add('show');
});

document.addEventListener('click', e => {
  if (!e.target.closest('#ctxMenu')) ctxMenu.classList.remove('show');
});

// drag-and-drop
const overlay = document.getElementById('dragOverlay');
let dragCounter = 0;

document.addEventListener('dragenter', e => {
  e.preventDefault();
  e.dataTransfer.effectAllowed = 'copy';
  dragCounter++;
  overlay.classList.add('show');
}, true);

document.addEventListener('dragover', e => {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
}, true);

document.addEventListener('dragleave', e => {
  e.preventDefault();
  dragCounter--;
  if (dragCounter <= 0) {
    dragCounter = 0;
    overlay.classList.remove('show');
  }
}, true);

document.addEventListener('drop', async e => {
  e.preventDefault();
  e.stopPropagation();
  e.dataTransfer.dropEffect = 'copy';
  dragCounter = 0;
  overlay.classList.remove('show');
  const files = await getFilesFromDrop(e.dataTransfer);
  if (files.length === 0) return;

  // Files <= 5MB use base64 (single message, no IPC fragmentation issues)
  const MAX_BASE64_SIZE = 5 * 1024 * 1024;
  const CHUNK_SIZE = 5 * 1024 * 1024;

  const smallFiles = [];
  for (const file of files) {
    if (file.size <= MAX_BASE64_SIZE) {
      const dataUrl = await new Promise(resolve => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.readAsDataURL(file);
      });
      smallFiles.push({ fileName: file.name, content: dataUrl.split(',')[1] });
    } else {
      // Files > 5MB use chunk upload with throttled sends
      const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
      const transferId = file.name.replace(/[/\]/g, '_') + '-' + file.size + '-' + Date.now();
      try {
        for (let i = 0; i < totalChunks; i++) {
          const start = i * CHUNK_SIZE;
          const end = Math.min(start + CHUNK_SIZE, file.size);
          const blob = file.slice(start, end);
          const arrayBuf = await blob.arrayBuffer();
          vscodeApi.postMessage({
            type: 'uploadDropChunk',
            transferId,
            fileName: file.name,
            chunk: new Uint8Array(arrayBuf),
            chunkIndex: i,
            totalChunks,
            fileSize: file.size,
          });
        }
      } catch (e2) {
        vscodeApi.postMessage({ type: 'showError', text: 'Chunk upload failed for ' + file.name + ': ' + (e2.message || e2) });
      }
    }
  }

  if (smallFiles.length > 0) {
    vscodeApi.postMessage({ type: 'uploadDrop', files: smallFiles });
  }
}, true);

async function getFilesFromDrop(dt) {
  // Use DataTransferItem API (supports folders) when available
  if (dt.items && dt.items.length > 0) {
    const items = Array.from(dt.items);
    const files = [];
    for (const item of items) {
      const getEntry = item.webkitGetAsEntry || item.getAsEntry;
      if (getEntry) {
        const entry = getEntry.call(item);
        if (!entry) continue;
        if (entry.isDirectory) {
          await readDir(entry, entry.name + '/', files);
        } else if (entry.isFile) {
          await readFileEntry(entry, '', files);
        }
      } else {
        const f = item.getAsFile ? item.getAsFile() : null;
        if (f && !f.name.startsWith('.')) files.push(f);
      }
    }
    return files;
  }
  // Fallback to FileList API (no folder support)
  return Array.from(dt.files).filter(f => !f.name.startsWith('.'));
}

async function readFileEntry(entry, path, files) {
  try {
    const file = await new Promise((resolve, reject) => {
      entry.file(f => resolve(f), err => reject(err));
    });
    if (!file || file.name.startsWith('.')) return;
    Object.defineProperty(file, 'name', { value: path + file.name });
    files.push(file);
  } catch (e2) {
    vscodeApi.postMessage({ type: 'showError', text: 'Failed to read file: ' + (path || '') + entry.name + ': ' + (e2.message || e2) });
  }
}

async function readDir(dirEntry, path, files) {
  const reader = dirEntry.createReader();
  const allEntries = [];
  while (true) {
    const entries = await new Promise(resolve => reader.readEntries(resolve));
    if (entries.length === 0) break;
    allEntries.push(...entries);
  }
  for (const entry of allEntries) {
    if (entry.name.startsWith('.')) continue;
    if (entry.isDirectory) {
      await readDir(entry, path + entry.name + '/', files);
    } else if (entry.isFile) {
      await readFileEntry(entry, path, files);
    }
  }
}

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
  const section = document.querySelector('.content-section');
  if (section) sessionStorage.setItem('scrollPos', String(section.scrollTop));
  vscodeApi.postMessage({ type: 'loadMore' });
});

const backBtn = document.getElementById('backBtn');
if (backBtn && !backBtn.disabled) {
  backBtn.addEventListener('click', () => {
    vscodeApi.postMessage({ type: 'navigateUp' });
  });
}

document.getElementById('newFolderBtn')?.addEventListener('click', () => {
  vscodeApi.postMessage({ type: 'newFolder' });
});
document.getElementById('uploadBtn')?.addEventListener('click', () => {
  vscodeApi.postMessage({ type: 'upload' });
});
document.getElementById('taskViewBtn')?.addEventListener('click', () => {
  vscodeApi.postMessage({ type: 'openTaskView' });
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
