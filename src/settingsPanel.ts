import * as vscode from 'vscode';
import { ConnectionManager, S3Connection } from './connectionManager';
import { createClient, testConnection } from './s3Client';
import { t, isZh } from './i18n';

export class SettingsPanel {
  public static currentPanel: SettingsPanel | undefined;

  public static createOrShow(connectionManager: ConnectionManager): void {
    const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;
    if (SettingsPanel.currentPanel) {
      SettingsPanel.currentPanel.panel.reveal(column);
      SettingsPanel.currentPanel.update(connectionManager);
      return;
    }
    SettingsPanel.currentPanel = new SettingsPanel(column, connectionManager);
  }

  private panel: vscode.WebviewPanel;
  private connectionManager: ConnectionManager;
  private editingId: string | undefined;
  private formData: Partial<S3Connection> = {};

  private constructor(column: vscode.ViewColumn, connectionManager: ConnectionManager) {
    this.connectionManager = connectionManager;

    this.panel = vscode.window.createWebviewPanel(
      's3Settings',
      t('wv_settings_title'),
      column,
      { enableScripts: true }
    );
    this.panel.iconPath = new vscode.ThemeIcon('gear');

    this.render();

    this.panel.onDidDispose(() => {
      SettingsPanel.currentPanel = undefined;
    });

    this.panel.webview.onDidReceiveMessage(async (message) => {
      switch (message.type) {
        case 'ready':
          this.render();
          break;
        case 'add':
          this.editingId = undefined;
          this.formData = { region: 'us-east-1', forcePathStyle: false };
          this.renderForm();
          break;
        case 'edit':
          this.editingId = message.connectionId;
          const conn = this.connectionManager.getConnection(message.connectionId);
          if (conn) {
            this.formData = { ...conn };
            this.renderForm();
          }
          break;
        case 'delete':
          const id = message.connectionId as string;
          const c = this.connectionManager.getConnection(id);
          if (c) {
            const confirmed = await vscode.window.showWarningMessage(
              t('msg_removeConfirm', c.name),
              { modal: true },
              t('msg_removeBtn')
            );
            if (confirmed) {
              await this.connectionManager.removeConnection(id);
              this.render();
            }
          }
          break;
        case 'save':
          await this.handleSave(message.data);
          break;
        case 'cancel':
          this.editingId = undefined;
          this.formData = {};
          this.render();
          break;
        case 'test':
          await this.handleTest(message.data);
          break;
      }
    });
  }

  private async update(connectionManager: ConnectionManager): Promise<void> {
    this.connectionManager = connectionManager;
    this.render();
  }

  private render(): void {
    this.panel.webview.html = getListHtml(this.connectionManager.connections);
  }

  private renderForm(): void {
    this.panel.webview.html = getFormHtml(this.formData, !!this.editingId);
  }

  private async handleSave(data: any): Promise<void> {
    if (!data) return;
    if (!data.name || !data.endpoint || !data.bucket || !data.accessKeyId || !data.secretAccessKey) {
      vscode.window.showErrorMessage(t('val_required'));
      return;
    }
    const conn: S3Connection = {
      id: this.editingId || '',
      name: data.name,
      endpoint: data.endpoint.replace(/\/+$/, ''),
      region: data.region || 'us-east-1',
      bucket: data.bucket,
      forcePathStyle: data.forcePathStyle === true || data.forcePathStyle === 'true',
      accessKeyId: data.accessKeyId,
      secretAccessKey: data.secretAccessKey,
    };
    if (this.editingId) {
      conn.id = this.editingId;
      await this.connectionManager.updateConnection(this.editingId, conn);
    } else {
      await this.connectionManager.addConnection(conn);
    }
    this.editingId = undefined;
    this.formData = {};
    this.render();
  }

  private async handleTest(data: any): Promise<void> {
    if (!data) return;
    const conn: S3Connection = {
      id: '',
      name: data.name || '',
      endpoint: (data.endpoint || '').replace(/\/+$/, ''),
      region: data.region || 'us-east-1',
      bucket: data.bucket || '',
      forcePathStyle: data.forcePathStyle === true || data.forcePathStyle === 'true',
      accessKeyId: data.accessKeyId || '',
      secretAccessKey: data.secretAccessKey || '',
    };
    if (!conn.endpoint || !conn.bucket) {
      vscode.window.showErrorMessage(t('val_endpointBucketRequired'));
      return;
    }
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: t('msg_testingConnection') },
      async () => {
        const client = createClient(conn);
        const result = await testConnection(client, conn.bucket);
        if (result.ok) {
          vscode.window.showInformationMessage(t('msg_connected', conn.name || conn.bucket));
        } else {
          vscode.window.showErrorMessage(t('msg_connectionFailed', result.error || 'Unknown error'));
        }
      }
    );
  }
}

function getListHtml(connections: S3Connection[]): string {
  const rows = connections.length === 0
    ? `<div class="empty">${t('wv_settings_empty')}</div>`
    : connections.map(c => {
        const icon = c.forcePathStyle ? '🔧' : '☁️';
        return `<div class="conn-row" data-id="${c.id}">
          <div class="conn-info">
            <span class="conn-icon">${icon}</span>
            <div class="conn-details">
              <div class="conn-name">${escapeHtml(c.name)}</div>
              <div class="conn-meta">${escapeHtml(c.endpoint)} / ${escapeHtml(c.bucket)}</div>
            </div>
          </div>
          <div class="conn-actions">
            <button class="action-btn edit-btn" data-action="edit" title="${t('wv_settings_edit')}">✏️</button>
            <button class="action-btn delete-btn" data-action="delete" title="${t('wv_settings_delete')}">🗑️</button>
          </div>
        </div>`;
      }).join('\n');

  return `<!DOCTYPE html>
<html lang="${isZh() ? 'zh-CN' : 'en'}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
body { margin:0; padding:16px; font-family:var(--vscode-font-family); font-size:var(--vscode-font-size); color:var(--vscode-foreground); background:var(--vscode-editor-background); }
.header { display:flex; align-items:center; justify-content:space-between; margin-bottom:16px; }
.header-title { font-size:18px; font-weight:600; }
.empty { text-align:center; margin-top:48px; color:var(--vscode-descriptionForeground); }
.add-btn { background:var(--vscode-button-background); color:var(--vscode-button-foreground); border:none; padding:6px 16px; cursor:pointer; border-radius:2px; font-size:var(--vscode-font-size); }
.add-btn:hover { background:var(--vscode-button-hoverBackground); }
.conn-row { display:flex; align-items:center; justify-content:space-between; padding:10px 12px; margin-bottom:4px; border-radius:4px; border:1px solid var(--vscode-panel-border); }
.conn-row:hover { background:var(--vscode-list-hoverBackground); }
.conn-info { display:flex; align-items:center; gap:10px; flex:1; min-width:0; }
.conn-icon { font-size:20px; }
.conn-details { flex:1; min-width:0; }
.conn-name { font-weight:600; font-size:14px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.conn-meta { font-size:12px; color:var(--vscode-descriptionForeground); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; margin-top:2px; }
.conn-actions { display:flex; gap:6px; flex-shrink:0; }
.action-btn { background:none; border:1px solid var(--vscode-panel-border); cursor:pointer; padding:4px 8px; border-radius:3px; font-size:14px; opacity:0.7; transition:opacity 0.15s; }
.action-btn:hover { opacity:1; background:var(--vscode-list-hoverBackground); }
</style>
</head>
<body>
<div class="header">
  <span class="header-title">⚙️ ${t('wv_settings_title')}</span>
  <button class="add-btn" id="addBtn">+ ${t('wv_settings_add')}</button>
</div>
${rows}
<script>
const vscodeApi = acquireVsCodeApi();
document.getElementById('addBtn').addEventListener('click', () => vscodeApi.postMessage({ type: 'add' }));
document.querySelectorAll('.edit-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const id = btn.closest('.conn-row').dataset.id;
    vscodeApi.postMessage({ type: 'edit', connectionId: id });
  });
});
document.querySelectorAll('.delete-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const id = btn.closest('.conn-row').dataset.id;
    vscodeApi.postMessage({ type: 'delete', connectionId: id });
  });
});
</script>
</body>
</html>`;
}

function getFormHtml(data: Partial<S3Connection>, isEdit: boolean): string {
  const name = data.name || '';
  const endpoint = data.endpoint || '';
  const region = data.region || 'us-east-1';
  const bucket = data.bucket || '';
  const forcePathStyle = data.forcePathStyle ?? false;
  const accessKeyId = data.accessKeyId || '';
  const secretAccessKey = data.secretAccessKey || '';

  return `<!DOCTYPE html>
<html lang="${isZh() ? 'zh-CN' : 'en'}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
body { margin:0; padding:16px; font-family:var(--vscode-font-family); font-size:var(--vscode-font-size); color:var(--vscode-foreground); background:var(--vscode-editor-background); }
.header { display:flex; align-items:center; gap:12px; margin-bottom:20px; }
.header-title { font-size:18px; font-weight:600; }
.back-btn { background:none; border:1px solid var(--vscode-panel-border); cursor:pointer; padding:4px 10px; border-radius:3px; font-size:var(--vscode-font-size); color:var(--vscode-foreground); }
.back-btn:hover { background:var(--vscode-list-hoverBackground); }
.field-group { margin-bottom:14px; }
label { display:block; font-size:12px; font-weight:600; margin-bottom:4px; color:var(--vscode-descriptionForeground); }
input, select { width:100%; box-sizing:border-box; padding:6px 8px; border:1px solid var(--vscode-input-border); border-radius:2px; background:var(--vscode-input-background); color:var(--vscode-input-foreground); font-size:var(--vscode-font-size); font-family:var(--vscode-font-family); }
input:focus { outline:none; border-color:var(--vscode-focusBorder); }
.hint { font-size:11px; color:var(--vscode-descriptionForeground); margin-top:2px; opacity:0.7; }
.checkbox-row { display:flex; align-items:center; gap:8px; margin:14px 0; }
.checkbox-row input { width:auto; }
.actions { display:flex; gap:8px; margin-top:20px; }
.btn-primary { background:var(--vscode-button-background); color:var(--vscode-button-foreground); border:none; padding:8px 20px; cursor:pointer; border-radius:2px; font-size:var(--vscode-font-size); }
.btn-primary:hover { background:var(--vscode-button-hoverBackground); }
.btn-secondary { background:var(--vscode-button-secondaryBackground); color:var(--vscode-button-secondaryForeground); border:none; padding:8px 20px; cursor:pointer; border-radius:2px; font-size:var(--vscode-font-size); }
.btn-secondary:hover { background:var(--vscode-button-secondaryHoverBackground); }
.btn-test { background:none; border:1px solid var(--vscode-panel-border); color:var(--vscode-foreground); padding:8px 20px; cursor:pointer; border-radius:2px; font-size:var(--vscode-font-size); }
.btn-test:hover { background:var(--vscode-list-hoverBackground); }
</style>
</head>
<body>
<div class="header">
  <button class="back-btn" id="backBtn">← ${t('wv_settings_back')}</button>
  <span class="header-title">${isEdit ? t('wv_settings_edit_title') : t('wv_settings_add_title')}</span>
</div>
<form id="connForm">
  <div class="field-group">
    <label for="name">${t('prompt_connectionName')}</label>
    <input type="text" id="name" value="${escapeHtml(name)}" placeholder="${t('prompt_connectionName_placeholder')}" required>
  </div>
  <div class="field-group">
    <label for="endpoint">${t('prompt_endpoint')}</label>
    <input type="url" id="endpoint" value="${escapeHtml(endpoint)}" placeholder="${t('prompt_endpoint_placeholder')}" required>
  </div>
  <div class="field-group">
    <label for="region">${t('prompt_region')}</label>
    <input type="text" id="region" value="${escapeHtml(region)}" placeholder="${t('prompt_region_placeholder')}">
  </div>
  <div class="field-group">
    <label for="bucket">${t('prompt_bucket')}</label>
    <input type="text" id="bucket" value="${escapeHtml(bucket)}" placeholder="${t('prompt_bucket_placeholder')}" required>
  </div>
  <div class="checkbox-row">
    <input type="checkbox" id="forcePathStyle" ${forcePathStyle ? 'checked' : ''}>
    <label for="forcePathStyle" style="margin:0;font-size:var(--vscode-font-size);cursor:pointer;">${t('prompt_pathStyle')}</label>
  </div>
  <div class="field-group">
    <label for="accessKeyId">${t('prompt_accessKey')}</label>
    <input type="text" id="accessKeyId" value="${escapeHtml(accessKeyId)}" placeholder="${t('prompt_accessKey_placeholder')}" required>
  </div>
  <div class="field-group">
    <label for="secretAccessKey">${t('prompt_secretKey')}</label>
    <input type="password" id="secretAccessKey" value="${escapeHtml(secretAccessKey)}" placeholder="${t('prompt_secretKey_placeholder')}" required>
  </div>
  <div class="actions">
    <button type="submit" class="btn-primary">${t('wv_settings_save')}</button>
    <button type="button" class="btn-test" id="testBtn">${t('wv_settings_test')}</button>
    <button type="button" class="btn-secondary" id="cancelBtn">${t('wv_settings_cancel')}</button>
  </div>
</form>
<script>
const vscodeApi = acquireVsCodeApi();
document.getElementById('backBtn').addEventListener('click', () => vscodeApi.postMessage({ type: 'cancel' }));
document.getElementById('cancelBtn').addEventListener('click', () => vscodeApi.postMessage({ type: 'cancel' }));
document.getElementById('testBtn').addEventListener('click', () => {
  vscodeApi.postMessage({ type: 'test', data: getFormData() });
});
document.getElementById('connForm').addEventListener('submit', e => {
  e.preventDefault();
  vscodeApi.postMessage({ type: 'save', data: getFormData() });
});
function getFormData() {
  return {
    name: document.getElementById('name').value.trim(),
    endpoint: document.getElementById('endpoint').value.trim(),
    region: document.getElementById('region').value.trim() || 'us-east-1',
    bucket: document.getElementById('bucket').value.trim(),
    forcePathStyle: document.getElementById('forcePathStyle').checked,
    accessKeyId: document.getElementById('accessKeyId').value.trim(),
    secretAccessKey: document.getElementById('secretAccessKey').value.trim(),
  };
}
</script>
</body>
</html>`;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
