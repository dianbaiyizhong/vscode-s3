import * as vscode from 'vscode';

const MAX_RECORDS = 50;
const STORAGE_KEY = 'jumpHistory';

export interface JumpRecord {
  connectionId: string;
  key: string;
  label: string;
  connectionName: string;
  timestamp: number;
  bookmarked?: boolean;
}

const BOOKMARK_KEY = 'jumpBookmarks';

export class JumpHistory {
  private records: JumpRecord[] = [];
  private storage: vscode.Memento;

  constructor(storage: vscode.Memento) {
    this.storage = storage;
    this.records = storage.get<JumpRecord[]>(STORAGE_KEY, []);
    const savedBookmarks = storage.get<string[]>(BOOKMARK_KEY, []);
    for (const r of this.records) {
      if (savedBookmarks.includes(r.connectionId + ':' + r.key)) {
        r.bookmarked = true;
      }
    }
  }

  private save(): void {
    this.storage.update(STORAGE_KEY, this.records);
  }

  private saveBookmarks(): void {
    const bm = this.records.filter(r => r.bookmarked).map(r => r.connectionId + ':' + r.key);
    this.storage.update(BOOKMARK_KEY, bm);
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

  toggleBookmark(connectionId: string, key: string): boolean {
    let record = this.records.find(r => r.connectionId === connectionId && r.key === key);
    if (!record) {
      record = { connectionId, key, label: key.split('/').filter(Boolean).pop() || key, connectionName: '', timestamp: Date.now() };
      this.records.unshift(record);
    }
    record.bookmarked = !record.bookmarked;
    this.saveBookmarks();
    return record.bookmarked;
  }

  isBookmarked(connectionId: string, key: string): boolean {
    return this.records.some(r => r.connectionId === connectionId && r.key === key && r.bookmarked);
  }

  getBookmarks(): JumpRecord[] {
    return this.records.filter(r => r.bookmarked).sort((a, b) => b.timestamp - a.timestamp);
  }

  getRecords(): JumpRecord[] {
    return [...this.records];
  }

  clear(): void {
    this.records = [];
    this.storage.update(BOOKMARK_KEY, []);
    this.save();
  }
}
