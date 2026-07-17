import * as vscode from 'vscode';
import { ConnectionManager } from './connectionManager';
import { S3ExplorerProvider } from './treeView';
import { registerCommands } from './commands';
import { JumpHistory } from './jumpHistory';
import { taskManager } from './taskManager';
import { initI18n } from './i18n';

export function activate(context: vscode.ExtensionContext): void {
  initI18n();

  const connectionManager = new ConnectionManager(context);
  const treeProvider = new S3ExplorerProvider(connectionManager);
  const jumpHistory = new JumpHistory(context.globalState);
  taskManager.init(context.globalState);

  vscode.window.createTreeView('s3Explorer', {
    treeDataProvider: treeProvider,
  });

  registerCommands(context, connectionManager, treeProvider, jumpHistory);

  context.subscriptions.push(
    vscode.window.registerWebviewPanelSerializer('s3TaskView', {
      async deserializeWebviewPanel(panel: vscode.WebviewPanel) {
        try { panel.dispose(); } catch { /* already disposed */ }
      }
    }),
    vscode.window.registerWebviewPanelSerializer('folderBrowser', {
      async deserializeWebviewPanel(panel: vscode.WebviewPanel) {
        try { panel.dispose(); } catch { /* already disposed */ }
      }
    })
  );
}
