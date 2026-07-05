import * as vscode from 'vscode';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { ConnectionManager } from './connectionManager';
import { createClient } from './s3Client';
import { S3ExplorerProvider } from './treeView';
import { registerCommands } from './commands';
import { PreviewManager } from './previewManager';
import { JumpHistory } from './jumpHistory';
import { initI18n, t } from './i18n';

export function activate(context: vscode.ExtensionContext): void {
  initI18n();

  const connectionManager = new ConnectionManager(context);
  const treeProvider = new S3ExplorerProvider(connectionManager);
  const previewManager = new PreviewManager();
  const jumpHistory = new JumpHistory(context.globalState);

  vscode.window.createTreeView('s3Explorer', {
    treeDataProvider: treeProvider,
  });

  registerCommands(context, connectionManager, treeProvider, jumpHistory);

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
