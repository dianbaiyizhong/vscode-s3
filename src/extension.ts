import * as vscode from 'vscode';
import { ConnectionManager } from './connectionManager';
import { S3ExplorerProvider } from './treeView';
import { registerCommands } from './commands';

export function activate(context: vscode.ExtensionContext): void {
  const connectionManager = new ConnectionManager(context);
  const treeProvider = new S3ExplorerProvider(connectionManager);

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('s3Explorer', treeProvider)
  );

  registerCommands(context, connectionManager, treeProvider);
}

export function deactivate(): void {
  // Cleanup if needed
}
