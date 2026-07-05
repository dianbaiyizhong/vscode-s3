import * as vscode from 'vscode';
import { JumpHistory, JumpRecord } from './jumpHistory';

export class JumpHistoryPanel {
  public static currentPanel: JumpHistoryPanel | undefined;

  public static refresh(): void {
    if (JumpHistoryPanel.currentPanel) {
      JumpHistoryPanel.currentPanel.render(JumpHistoryPanel.currentPanel.history.getRecords());
    }
  }

  public static createOrShow(history: JumpHistory, onJump: (record: JumpRecord) => void): void {
    const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;

    if (JumpHistoryPanel.currentPanel) {
      JumpHistoryPanel.currentPanel.panel.reveal(column);
      JumpHistoryPanel.currentPanel.update(history, onJump);
      return;
    }

    JumpHistoryPanel.currentPanel = new JumpHistoryPanel(column, history, onJump);
  }

  private panel: vscode.WebviewPanel;
  private onJump: (record: JumpRecord) => void;
  public history: JumpHistory;

  private constructor(column: vscode.ViewColumn, history: JumpHistory, onJump: (record: JumpRecord) => void) {
    this.onJump = onJump;
    this.history = history;

    this.panel = vscode.window.createWebviewPanel(
      'jumpHistory',
      'Jump History',
      column,
      { enableScripts: true }
    );
    this.panel.iconPath = new vscode.ThemeIcon('history');

    this.render(history.getRecords());

    this.panel.onDidDispose(() => {
      JumpHistoryPanel.currentPanel = undefined;
    });

    this.panel.webview.onDidReceiveMessage(message => {
      switch (message.type) {
        case 'jump':
          onJump(message.record);
          break;
        case 'clear':
          history.clear();
          this.render(history.getRecords());
          break;
      }
    });
  }

  private update(history: JumpHistory, onJump: (record: JumpRecord) => void): void {
    this.onJump = onJump;
    this.render(history.getRecords());
  }

  private render(records: JumpRecord[]): void {
    this.panel.title = `Jump History (${records.length})`;
    this.panel.webview.html = getHtml(records);
  }
}

function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  const now = Date.now();
  const diff = now - timestamp;

  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function getHtml(records: JumpRecord[]): string {
  const rows = records.length === 0
    ? `<div class="empty">No jump history</div>`
    : records.map((r, idx) => `
      <div class="entry" data-idx="${idx}">
        <div class="entry-icon">&#x1F550;</div>
        <div class="entry-body">
          <div class="entry-label">${escapeHtml(r.label)}</div>
          <div class="entry-key">${escapeHtml(r.key)}</div>
          <div class="entry-meta">${escapeHtml(r.connectionName)} · ${formatTime(r.timestamp)}</div>
        </div>
      </div>
    `).join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
body {
  margin: 0;
  padding: 16px;
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size);
  color: var(--vscode-foreground);
  background: var(--vscode-editor-background);
}
.header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 16px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--vscode-panel-border);
}
.header-title {
  font-size: 16px;
  font-weight: 600;
}
.clear-btn {
  background: none;
  border: 1px solid var(--vscode-button-secondaryBackground);
  color: var(--vscode-button-secondaryForeground);
  background: var(--vscode-button-secondaryBackground);
  padding: 4px 12px;
  cursor: pointer;
  border-radius: 2px;
  font-size: var(--vscode-font-size);
}
.clear-btn:hover {
  background: var(--vscode-button-secondaryHoverBackground);
}
.empty {
  text-align: center;
  margin-top: 48px;
  color: var(--vscode-descriptionForeground);
}
.entry {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 10px 12px;
  margin-bottom: 4px;
  cursor: pointer;
  border-radius: 4px;
  border: 1px solid transparent;
  transition: background 0.15s;
}
.entry:hover {
  background: var(--vscode-list-hoverBackground);
  border-color: var(--vscode-list-hoverBackground);
}
.entry:active {
  background: var(--vscode-list-activeSelectionBackground);
  color: var(--vscode-list-activeSelectionForeground);
}
.entry-icon {
  font-size: 18px;
  line-height: 22px;
  opacity: 0.7;
  flex-shrink: 0;
}
.entry-body {
  flex: 1;
  min-width: 0;
}
.entry-label {
  font-weight: 600;
  font-size: 14px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.entry-key {
  font-size: 12px;
  color: var(--vscode-descriptionForeground);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  margin-top: 2px;
}
.entry-meta {
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
  opacity: 0.8;
  margin-top: 2px;
}
</style>
</head>
<body>
<div class="header">
  <span class="header-title">&#x1F550; Jump History</span>
  ${records.length > 0 ? '<button class="clear-btn" id="clearBtn">Clear All</button>' : ''}
</div>
${rows}
<script>
const records = ${JSON.stringify(records)};
document.querySelectorAll('.entry').forEach(el => {
  el.addEventListener('click', () => {
    const idx = parseInt(el.dataset.idx);
    const vscodeApi = acquireVsCodeApi();
    vscodeApi.postMessage({ type: 'jump', record: records[idx] });
  });
});
const clearBtn = document.getElementById('clearBtn');
if (clearBtn) {
  clearBtn.addEventListener('click', () => {
    const vscodeApi = acquireVsCodeApi();
    vscodeApi.postMessage({ type: 'clear' });
  });
}
</script>
</body>
</html>`;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
