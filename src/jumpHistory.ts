import * as vscode from 'vscode';

const MAX_RECORDS = 50;
const STORAGE_KEY = 'jumpHistory';

export interface JumpRecord {
  connectionId: string;
  key: string;
  label: string;
  connectionName: string;
  timestamp: number;
}

export class JumpHistory {
  private records: JumpRecord[] = [];
  private storage: vscode.Memento;

  constructor(storage: vscode.Memento) {
    this.storage = storage;
    this.records = storage.get<JumpRecord[]>(STORAGE_KEY, []);
  }

  private save(): void {
    this.storage.update(STORAGE_KEY, this.records);
  }

  addRecord(connectionId: string, key: string, label: string, connectionName: string): void {
    const existing = this.records.findIndex(r => r.connectionId === connectionId && r.key === key);
    if (existing !== -1) {
      this.records.splice(existing, 1);
    }
    this.records.unshift({ connectionId, key, label, connectionName, timestamp: Date.now() });
    if (this.records.length > MAX_RECORDS) {
      this.records = this.records.slice(0, MAX_RECORDS);
    }
    this.save();
  }

  getRecords(): JumpRecord[] {
    return [...this.records];
  }

  clear(): void {
    this.records = [];
    this.save();
  }
}
