import * as fs from 'fs';
import * as path from 'path';
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
}

interface ConfigFile {
  connections: S3Connection[];
}

const CONFIG_FILE = path.join(process.env.HOME || process.env.USERPROFILE || '', '.s3_config');

function readConfig(): ConfigFile {
  try {
    if (!fs.existsSync(CONFIG_FILE)) return { connections: [] };
    const raw = fs.readFileSync(CONFIG_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return { connections: [] };
  }
}

function writeConfig(data: ConfigFile): void {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

export class ConnectionManager {
  private _connections: S3Connection[] = [];
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  constructor(_context: vscode.ExtensionContext) {
    this.loadConnections();
  }

  private loadConnections(): void {
    this._connections = readConfig().connections;
  }

  private async saveConnections(): Promise<void> {
    writeConfig({ connections: this._connections });
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
    await this.saveConnections();
    return conn;
  }

  async updateConnection(id: string, params: Partial<S3Connection>): Promise<S3Connection | undefined> {
    const idx = this._connections.findIndex(c => c.id === id);
    if (idx === -1) return undefined;
    this._connections[idx] = { ...this._connections[idx], ...params };
    await this.saveConnections();
    return this._connections[idx];
  }

  async removeConnection(id: string): Promise<void> {
    this._connections = this._connections.filter(c => c.id !== id);
    await this.saveConnections();
  }
}
