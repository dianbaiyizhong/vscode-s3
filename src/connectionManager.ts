import * as vscode from 'vscode';

export interface S3Connection {
  id: string;
  name: string;
  endpoint: string;
  region: string;
  bucket: string;
  forcePathStyle: boolean;
}

export interface S3ConnectionSecrets {
  accessKeyId: string;
  secretAccessKey: string;
}

const CONNECTIONS_KEY = 's3-connections-metadata';

export class ConnectionManager {
  private _connections: S3Connection[] = [];
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  constructor(private context: vscode.ExtensionContext) {
    this.loadConnections();
  }

  private loadConnections(): void {
    this._connections = this.context.globalState.get<S3Connection[]>(CONNECTIONS_KEY, []);
  }

  private async saveConnections(): Promise<void> {
    await this.context.globalState.update(CONNECTIONS_KEY, this._connections);
    this._onDidChange.fire();
  }

  get connections(): S3Connection[] {
    return [...this._connections];
  }

  getConnection(id: string): S3Connection | undefined {
    return this._connections.find(c => c.id === id);
  }

  async addConnection(params: {
    name: string;
    endpoint: string;
    region: string;
    bucket: string;
    forcePathStyle: boolean;
    accessKeyId: string;
    secretAccessKey: string;
  }): Promise<S3Connection> {
    const id = `s3-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
    const { accessKeyId, secretAccessKey, ...rest } = params;
    const conn: S3Connection = { ...rest, id };
    this._connections.push(conn);
    await this.saveConnections();
    await this.context.secrets.store(`s3-ak-${id}`, accessKeyId);
    await this.context.secrets.store(`s3-sk-${id}`, secretAccessKey);
    return conn;
  }

  async updateConnection(id: string, params: Partial<Omit<S3Connection, 'id'>> & { accessKeyId?: string; secretAccessKey?: string }): Promise<S3Connection | undefined> {
    const idx = this._connections.findIndex(c => c.id === id);
    if (idx === -1) return undefined;
    const { accessKeyId, secretAccessKey, ...rest } = params;
    this._connections[idx] = { ...this._connections[idx], ...rest };
    await this.saveConnections();
    if (accessKeyId !== undefined) {
      await this.context.secrets.store(`s3-ak-${id}`, accessKeyId);
    }
    if (secretAccessKey !== undefined) {
      await this.context.secrets.store(`s3-sk-${id}`, secretAccessKey);
    }
    return this._connections[idx];
  }

  async removeConnection(id: string): Promise<void> {
    this._connections = this._connections.filter(c => c.id !== id);
    await this.saveConnections();
    await this.context.secrets.delete(`s3-ak-${id}`);
    await this.context.secrets.delete(`s3-sk-${id}`);
  }

  async getCredentials(id: string): Promise<S3ConnectionSecrets | undefined> {
    const accessKeyId = await this.context.secrets.get(`s3-ak-${id}`);
    const secretAccessKey = await this.context.secrets.get(`s3-sk-${id}`);
    if (!accessKeyId || !secretAccessKey) return undefined;
    return { accessKeyId, secretAccessKey };
  }
}
