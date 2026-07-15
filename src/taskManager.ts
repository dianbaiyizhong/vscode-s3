import * as vscode from 'vscode';

export type TaskType = 'upload' | 'download';
export type TaskStatus = 'queued' | 'in_progress' | 'completed' | 'failed' | 'interrupted';

export interface Task {
  id: string;
  type: TaskType;
  fileName: string;
  status: TaskStatus;
  progress: number;
  size?: number;
  source?: string;
  destination?: string;
  error?: string;
  createdAt: number;
  completedAt?: number;
  connectionName?: string;
  bucket?: string;
}

type TaskListener = (tasks: readonly Task[]) => void;
const STORAGE_KEY = 'taskManagerTasks';
const MAX_TASKS = 100;

class TaskManager {
  private _tasks: Task[] = [];
  private _listeners = new Set<TaskListener>();
  private _idCounter = 0;
  private _storage: vscode.Memento | undefined;

  init(storage: vscode.Memento): void {
    this._storage = storage;
    const saved = storage.get<Task[]>(STORAGE_KEY, []);
    for (const t of saved) {
      if (t.status === 'in_progress' || t.status === 'queued') {
        t.status = 'interrupted';
      }
    }
    this._tasks = saved;
    this._idCounter = saved.length;
  }

  get tasks(): readonly Task[] {
    return this._tasks;
  }

  add(init: Omit<Task, 'id' | 'createdAt' | 'status' | 'progress'>): string {
    const id = `task_${++this._idCounter}_${Date.now()}`;
    this._tasks.unshift({
      ...init,
      id,
      status: 'in_progress',
      progress: 0,
      createdAt: Date.now(),
    });
    this._notify();
    this._save();
    return id;
  }

  /** Show current task count in status bar (for debugging) */
  showStatusBar(): void {
    const count = this._tasks.length;
    const active = this._tasks.filter(t => t.status === 'in_progress').length;
    const msg = active > 0 ? `$(list-tree) ${active} active, ${count} total` : `$(list-tree) ${count} tasks`;
    vscode.window.setStatusBarMessage(msg, 6000);
  }

  updateProgress(id: string, progress: number): void {
    const t = this._tasks.find(x => x.id === id);
    if (t) {
      t.progress = Math.min(100, Math.max(0, progress));
      this._notify();
      this._save();
    }
  }

  complete(id: string): void {
    const t = this._tasks.find(x => x.id === id);
    if (t) {
      t.status = 'completed';
      t.progress = 100;
      t.completedAt = Date.now();
      this._notify();
      this._save();
    }
  }

  fail(id: string, error: string): void {
    const t = this._tasks.find(x => x.id === id);
    if (t) {
      t.status = 'failed';
      t.error = error;
      t.completedAt = Date.now();
      this._notify();
      this._save();
    }
  }

  remove(id: string): void {
    this._tasks = this._tasks.filter(x => x.id !== id);
    this._notify();
  }

  clearCompleted(): void {
    this._tasks = this._tasks.filter(x => x.status === 'in_progress' || x.status === 'queued');
    this._notify();
    this._save();
  }

  onDidChange(listener: TaskListener): vscode.Disposable {
    this._listeners.add(listener);
    return { dispose: () => this._listeners.delete(listener) };
  }

  private _save(): void {
    if (!this._storage) return;
    const toSave = this._tasks.slice(0, MAX_TASKS);
    this._storage.update(STORAGE_KEY, toSave).catch(() => {});
  }

  private _notify(): void {
    const snapshot = Object.freeze([...this._tasks]);
    for (const fn of this._listeners) {
      try { fn(snapshot); } catch { /* ignore */ }
    }
  }
}

export const taskManager = new TaskManager();
