import * as vscode from 'vscode';
import { taskManager, Task } from './taskManager';
import { t as _t } from './i18n';

export class TaskViewPanel {
  public static currentPanel: TaskViewPanel | undefined;
  private readonly _panel: vscode.WebviewPanel;
  private readonly _disposables: vscode.Disposable[] = [];

  static createOrShow(): void {
    if (TaskViewPanel.currentPanel) {
      // Always recreate — fresh panel guarantees content renders
      TaskViewPanel.currentPanel.dispose();
    }
    const panel = vscode.window.createWebviewPanel(
      's3TaskView',
      _t('tv_title'),
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      { enableScripts: true, retainContextWhenHidden: true }
    );
    panel.iconPath = new vscode.ThemeIcon('checklist');
    TaskViewPanel.currentPanel = new TaskViewPanel(panel);
  }

  private constructor(panel: vscode.WebviewPanel) {
    this._panel = panel;
    panel.onDidDispose(() => this.dispose(), null, this._disposables);
    panel.webview.html = this._buildHtml();

    this._disposables.push(
      taskManager.onDidChange(() => {
        if (this._panel.visible) {
          this._panel.webview.html = this._buildHtml();
        }
      })
    );

    panel.webview.onDidReceiveMessage(msg => {
      if (msg.type === 'clearCompleted') {
        taskManager.clearCompleted();
        this._panel.webview.html = this._buildHtml();
      }
    }, null, this._disposables);
  }

  private _refreshNow(): void {
    this._panel.webview.html = this._buildHtml();
  }

  private _buildHtml(): string {
    const all = taskManager.tasks;
    const rows = all.length === 0
      ? `<tr><td colspan="5" class="empty">${_t('tv_empty')}</td></tr>`
      : all.map(t => this._renderRow(t)).join('');

    const hasCompleted = all.some(t => t.status === 'completed' || t.status === 'failed');

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
* { margin:0; padding:0; box-sizing:border-box; }
body {
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size);
  color: var(--vscode-foreground);
  background: var(--vscode-sideBar-background);
  padding: 12px;
}
.header {
  display:flex; align-items:center; justify-content:space-between;
  margin-bottom:12px;
}
.header h2 { font-size:14px; font-weight:600; margin:0; }
.btn {
  background:var(--vscode-button-background); color:var(--vscode-button-foreground);
  border:none; padding:4px 12px; border-radius:2px; cursor:pointer; font-size:12px;
}
.btn:disabled { opacity:0.4; cursor:default; }
.btn:hover:not(:disabled) { background:var(--vscode-button-hoverBackground); }
table { width:100%; border-collapse:collapse; }
th {
  text-align:left; padding:6px 8px; font-weight:600; font-size:11px;
  text-transform:uppercase; color:var(--vscode-descriptionForeground);
  border-bottom:1px solid var(--vscode-panel-border); white-space:nowrap;
}
td { padding:8px 6px; border-bottom:1px solid var(--vscode-panel-border); vertical-align:middle; }
.empty { text-align:center; padding:32px 8px; color:var(--vscode-descriptionForeground); }
.type-icon { width:16px; height:16px; display:inline-block; text-align:center; font-size:14px; }
.type-icon.up { color:var(--vscode-charts-blue); }
.type-icon.down { color:var(--vscode-charts-green); }
.file-name { font-weight:500; word-break:break-all; }
.file-size { font-size:11px; color:var(--vscode-descriptionForeground); }
.progress-wrap { width:120px; }
progress {
  width:100%; height:6px; border:none; border-radius:3px;
}
progress::-webkit-progress-bar { background:var(--vscode-editorWidget-border); border-radius:3px; }
progress::-webkit-progress-value { background:var(--vscode-progressBar-background); border-radius:3px; }
.progress-pct { font-size:11px; color:var(--vscode-descriptionForeground); margin-top:2px; }
.status-badge {
  display:inline-block; padding:2px 8px; border-radius:8px; font-size:11px; font-weight:500;
}
.status-badge.in-progress { background:var(--vscode-editorInfo-background); color:var(--vscode-editorInfo-foreground); }
.status-badge.completed { background:var(--vscode-testing-iconPassed); color:#fff; }
.status-badge.failed { background:var(--vscode-testing-iconFailed); color:#fff; }
.error-msg { font-size:11px; color:var(--vscode-errorForeground); margin-top:2px; word-break:break-all; }
.time { font-size:11px; color:var(--vscode-descriptionForeground); white-space:nowrap; }
th:nth-child(4), td:nth-child(4) { width:90px; text-align:center; }
td:nth-child(2) { white-space:nowrap; }
</style>
</head>
<body>
<div class="header">
  <h2>${_t('tv_title')}</h2>
  <button class="btn" id="clearBtn">${_t('tv_clearCompleted')}</button>
</div>
<table>
<thead><tr>
  <th></th><th>${_t('wv_name')}</th><th>${_t('tv_progress')}</th><th>${_t('tv_status')}</th><th>${_t('tv_time')}</th>
</tr></thead>
<tbody>${rows}</tbody>
</table>
<script>
const vscode = acquireVsCodeApi();
document.getElementById('clearBtn').addEventListener('click', () => {
  vscode.postMessage({ type: 'clearCompleted' });
});
</script>
</body>
</html>`;
  }

  private _renderRow(t: Task): string {
    const icon = t.type === 'upload' ? '&#x2B06;' : '&#x2B07;';
    const iconCls = t.type === 'upload' ? 'up' : 'down';
    const statusLabel = this._statusLabel(t);
    const statusCls = t.status === 'in_progress' ? 'in-progress' : t.status;
    const sizeStr = t.size ? this._fmtSize(t.size) : '';
    const timeStr = t.completedAt ? this._fmtTime(t.completedAt) : this._fmtTime(t.createdAt);
    const pct = Math.round(t.progress);

    let statusHtml = `<span class="status-badge ${statusCls}">${this._escape(statusLabel)}</span>`;
    if (t.status === 'failed' && t.error) {
      statusHtml += `<div class="error-msg">${this._escape(t.error)}</div>`;
    }

    let progressHtml = '';
    if (t.status === 'in_progress') {
      progressHtml = `<div class="progress-wrap">
        <progress value="${pct}" max="100"></progress>
        <div class="progress-pct">${pct}%</div>
      </div>`;
    } else if (t.status === 'completed') {
      progressHtml = `<div class="progress-wrap">
        <progress value="100" max="100"></progress>
        <div class="progress-pct">100%</div>
      </div>`;
    } else if (t.status === 'failed') {
      progressHtml = `<span class="progress-pct">${pct}%</span>`;
    }

    return `<tr>
      <td><span class="type-icon ${iconCls}">${icon}</span></td>
      <td>
        <div class="file-name">${this._escape(t.fileName)}</div>
        ${sizeStr ? `<div class="file-size">${sizeStr}</div>` : ''}
      </td>
      <td>${progressHtml}</td>
      <td>${statusHtml}</td>
      <td class="time">${timeStr}</td>
    </tr>`;
  }

  private _statusLabel(task: Task): string {
    switch (task.status) {
      case 'in_progress': return _t('tv_inProgress');
      case 'completed': return _t('tv_completed');
      case 'failed': return _t('tv_failed');
      case 'interrupted': return _t('tv_interrupted');
      default: return task.status;
    }
  }

  private _fmtSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    if (bytes < 1024 * 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
    return `${(bytes / (1024 * 1024 * 1024 * 1024)).toFixed(1)} TB`;
  }

  private _fmtTime(ts: number): string {
    return new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  private _escape(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  dispose(): void {
    TaskViewPanel.currentPanel = undefined;
    this._panel.dispose();
    for (const d of this._disposables) d.dispose();
  }
}
