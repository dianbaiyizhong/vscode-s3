const MAX_RECORDS = 50;

export interface JumpRecord {
  connectionId: string;
  key: string;
  label: string;
  connectionName: string;
  timestamp: number;
}

export class JumpHistory {
  private records: JumpRecord[] = [];

  addRecord(connectionId: string, key: string, label: string, connectionName: string): void {
    const existing = this.records.findIndex(r => r.connectionId === connectionId && r.key === key);
    if (existing !== -1) {
      this.records.splice(existing, 1);
    }
    this.records.unshift({ connectionId, key, label, connectionName, timestamp: Date.now() });
    if (this.records.length > MAX_RECORDS) {
      this.records = this.records.slice(0, MAX_RECORDS);
    }
  }

  getRecords(): JumpRecord[] {
    return [...this.records];
  }

  clear(): void {
    this.records = [];
  }
}
