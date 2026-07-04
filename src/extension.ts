import * as vscode from 'vscode';
import * as path from 'path';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { ConnectionManager } from './connectionManager';
import { createClient, uploadFile } from './s3Client';
import { S3ExplorerProvider, S3TreeItem } from './treeView';
import { registerCommands } from './commands';
import { PreviewManager } from './previewManager';
import { JumpHistory } from './jumpHistory';
import { initI18n, t } from './i18n';

export function activate(context: vscode.ExtensionContext): void {
  initI18n();

  const connectionManager = new ConnectionManager(context);
  const treeProvider = new S3ExplorerProvider(connectionManager);
  const previewManager = new PreviewManager();
  const jumpHistory = new JumpHistory();

  const treeView = vscode.window.createTreeView('s3Explorer', {
    treeDataProvider: treeProvider,
    canSelectMany: true,
    dragAndDropController: {
      dropMimeTypes: ['files', 'text/uri-list'],
      dragMimeTypes: [],
      handleDrop: async (target, dataTransfer) => {
        if (!target || (target.contextValue !== 's3Folder' && target.contextValue !== 's3Connection')) return;

        const conn = connectionManager.getConnection(target.connectionId);
        const secrets = await connectionManager.getCredentials(target.connectionId);
        if (!conn || !secrets) return;

        const client = createClient(conn, secrets);
        const prefix = target.contextValue === 's3Folder' ? target.key : '';

        const uploaded: string[] = [];
        let failCount = 0;

        const processFile = async (filePath: string) => {
          const fileName = path.basename(filePath);
          const key = prefix + fileName;
          try {
            await uploadFile(client, conn.bucket, key, filePath);
            uploaded.push(fileName);
          } catch { failCount++; }
        };

        const uriList = dataTransfer.get('text/uri-list');
        if (uriList) {
          const text = await uriList.asString();
          const uris = text.split('\n').filter(l => l.trim()).map(l => vscode.Uri.parse(l.trim()));
          for (const uri of uris) {
            if (uri.scheme === 'file') await processFile(uri.fsPath);
          }
        }

        const filesEntry = dataTransfer.get('files');
        if (filesEntry) {
          const file = filesEntry.asFile();
          if (file?.uri?.scheme === 'file') {
            await processFile(file.uri.fsPath);
          }
        }

        if (uploaded.length > 0 || failCount > 0) {
          treeProvider.refresh();
          if (uploaded.length > 0 && failCount === 0) {
            vscode.window.showInformationMessage(t('msg_dropUploaded', uploaded.length));
          } else if (uploaded.length === 0) {
            vscode.window.showErrorMessage(t('msg_dropFailed'));
          } else {
            vscode.window.showWarningMessage(t('msg_dropWarn', t('msg_dropUploaded', uploaded.length), failCount));
          }
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
      const secrets = await connectionManager.getCredentials(mapping.connectionId);
      if (!conn || !secrets) return;

      const client = createClient(conn, secrets);
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
