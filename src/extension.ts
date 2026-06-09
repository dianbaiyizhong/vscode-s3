import * as vscode from 'vscode';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { ConnectionManager } from './connectionManager';
import { createClient } from './s3Client';
import { S3ExplorerProvider } from './treeView';
import { registerCommands } from './commands';
import { PreviewManager } from './previewManager';

export function activate(context: vscode.ExtensionContext): void {
  const connectionManager = new ConnectionManager(context);
  const treeProvider = new S3ExplorerProvider(connectionManager);
  const previewManager = new PreviewManager();

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('s3Explorer', treeProvider)
  );

  registerCommands(context, connectionManager, treeProvider, previewManager);

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
        vscode.window.setStatusBarMessage(`$(cloud-upload) Synced: ${mapping.key}`, 3000);
      } catch (err: any) {
        vscode.window.showWarningMessage(`Sync failed: ${err.message}`);
      }
    })
  );
}
