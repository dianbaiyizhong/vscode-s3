import * as vscode from 'vscode';
import * as path from 'path';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { ConnectionManager } from './connectionManager';
import { createClient, uploadFile } from './s3Client';
import { S3ExplorerProvider, S3TreeItem } from './treeView';
import { registerCommands } from './commands';
import { PreviewManager } from './previewManager';
import { JumpHistory } from './jumpHistory';
import { setConnectionManager } from './folderBrowserPanel';
import { initI18n, t } from './i18n';

export function activate(context: vscode.ExtensionContext): void {
  initI18n();

  const connectionManager = new ConnectionManager(context);
  setConnectionManager(connectionManager);
  const treeProvider = new S3ExplorerProvider(connectionManager);
  const previewManager = new PreviewManager();
  const jumpHistory = new JumpHistory(context.globalState);

  const treeView = vscode.window.createTreeView('s3Explorer', {
    treeDataProvider: treeProvider,
    canSelectMany: true,
    dragAndDropController: {
      dropMimeTypes: ['files', 'text/uri-list'],
      dragMimeTypes: [],
      handleDrop: async (target, dataTransfer) => {
        if (!target || (target.contextValue !== 's3Folder' && target.contextValue !== 's3Connection')) return;

        const conn = connectionManager.getConnection(target.connectionId);
        if (!conn) return;

        const client = createClient(conn);
        const prefix = target.contextValue === 's3Folder' ? target.key : '';

        const filePaths: string[] = [];

        const uriList = dataTransfer.get('text/uri-list');
        if (uriList) {
          const text = await uriList.asString();
          for (const line of text.split('\n')) {
            const uri = vscode.Uri.parse(line.trim());
            if (uri.scheme === 'file') filePaths.push(uri.fsPath);
          }
        }

        const filesEntry = dataTransfer.get('files');
        if (filesEntry) {
          const file = filesEntry.asFile();
          if (file?.uri?.scheme === 'file' && !filePaths.includes(file.uri.fsPath)) {
            filePaths.push(file.uri.fsPath);
          }
        }

        if (filePaths.length === 0) return;

        const uploaded: string[] = [];
        let failCount = 0;

        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: t('msg_uploadingFiles'),
          },
          async (progress) => {
            for (let i = 0; i < filePaths.length; i++) {
              const filePath = filePaths[i];
              const fileName = path.basename(filePath);
              const key = prefix + fileName;
              progress.report({ message: `${i + 1}/${filePaths.length} - ${fileName}` });
              try {
                await uploadFile(client, conn.bucket, key, filePath);
                uploaded.push(fileName);
              } catch { failCount++; }
            }
          }
        );

        treeProvider.refresh();
        if (uploaded.length > 0 && failCount === 0) {
          vscode.window.showInformationMessage(t('msg_dropUploaded', uploaded.length));
        } else if (uploaded.length === 0) {
          vscode.window.showErrorMessage(t('msg_dropFailed'));
        } else {
          vscode.window.showWarningMessage(t('msg_dropWarn', t('msg_dropUploaded', uploaded.length), failCount));
        }
      },
    },
  });
  S3ExplorerProvider.treeView = treeView;

  context.subscriptions.push(treeView);

  registerCommands(context, connectionManager, treeProvider, previewManager, jumpHistory);

  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(async (doc) => {
      const localPath = doc.uri.fsPath;
      if (!localPath || !previewManager.isTracked(localPath)) return;

      const mapping = previewManager.getMapping(localPath)!;
      const conn = connectionManager.getConnection(mapping.connectionId);
      if (!conn) return;

      const client = createClient(conn);
      try {
        const content = doc.getText();
        await client.send(
          new PutObjectCommand({
            Bucket: mapping.bucket,
            Key: mapping.key,
            Body: content,
          })
        );
        vscode.window.setStatusBarMessage(`$(cloud-upload) ${t('msg_synced', mapping.key)}`, 3000);
      } catch (err: any) {
        vscode.window.showWarningMessage(t('msg_syncFailed', err.message));
      }
    })
  );
}
