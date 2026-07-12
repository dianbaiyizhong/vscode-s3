import * as vscode from 'vscode';

export interface S3Connection {
  id: string;
  name: string;
  endpoint: string;
  region: string;
  bucket: string;
  forcePathStyle: boolean;
  accessKeyId: string;
  secretAccessKey: string;
  isHuaweiOBS?: boolean;
  proxyEnabled?: boolean;
  proxyUrl?: string;
  proxyUsername?: string;
  proxyPassword?: string;
  noProxy?: string;
}

const STORAGE_KEY = 's3Connections';

export class ConnectionManager {
  private _connections: S3Connection[] = [];
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;
  private storage: vscode.Memento;

  constructor(context: vscode.ExtensionContext) {
    this.storage = context.globalState;
    this.load();
  }

  private load(): void {
    this._connections = this.storage.get<S3Connection[]>(STORAGE_KEY, []);
  }

  private async save(): Promise<void> {
    await this.storage.update(STORAGE_KEY, this._connections);
    this._onDidChange.fire();
  }

  get connections(): S3Connection[] {
    return [...this._connections];
  }

  getConnection(id: string): S3Connection | undefined {
    return this._connections.find(c => c.id === id);
  }

  async addConnection(params: S3Connection): Promise<S3Connection> {
    const id = `s3-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
    const conn: S3Connection = { ...params, id };
    this._connections.push(conn);
    await this.save();
    return conn;
  }

  async updateConnection(id: string, params: Partial<S3Connection>): Promise<S3Connection | undefined> {
    const idx = this._connections.findIndex(c => c.id === id);
    if (idx === -1) return undefined;
    this._connections[idx] = { ...this._connections[idx], ...params, id };
    await this.save();
    return this._connections[idx];
  }

  async removeConnection(id: string): Promise<void> {
    this._connections = this._connections.filter(c => c.id !== id);
    await this.save();
  }
}
