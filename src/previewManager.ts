import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

export interface PreviewFileMapping {
  localPath: string;
  connectionId: string;
  bucket: string;
  key: string;
}

export const TEXT_EXTENSIONS = new Set([
  'txt', 'csv', 'tsv', 'json', 'xml', 'yaml', 'yml', 'md', 'markdown',
  'js', 'ts', 'jsx', 'tsx', 'mjs', 'cjs', 'mts', 'cts',
  'py', 'java', 'go', 'rb', 'php', 'c', 'cpp', 'h', 'hpp', 'cs', 'rs', 'swift', 'kt', 'scala',
  'html', 'htm', 'css', 'scss', 'less', 'sass', 'vue', 'svelte',
  'sh', 'bash', 'zsh', 'ps1', 'bat', 'cmd', 'fish',
  'cfg', 'conf', 'ini', 'toml', 'gradle',
  'log', 'env', 'properties', 'sql',
  'r', 'm', 'mm', 'pl', 'pm', 'lua', 'dart',
  'asm', 's', 'tex', 'bib',
]);

export const IMAGE_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'ico', 'avif', 'tiff', 'tif',
]);

function getExt(key: string): string {
  const idx = key.lastIndexOf('.');
  if (idx === -1) return '';
  return key.slice(idx + 1).toLowerCase();
}

export function isTextFile(key: string): boolean {
  return TEXT_EXTENSIONS.has(getExt(key));
}

export function isImageFile(key: string): boolean {
  return IMAGE_EXTENSIONS.has(getExt(key));
}

export function isPreviewable(key: string): boolean {
  return isTextFile(key) || isImageFile(key);
}

export class PreviewManager {
  private tempRoot: string;
  private mappings = new Map<string, PreviewFileMapping>();

  constructor() {
    this.tempRoot = path.join(os.tmpdir(), `vscode-s3-${Date.now().toString(36)}`);
    fs.mkdirSync(this.tempRoot, { recursive: true });
  }

  getTempPath(connectionId: string, key: string): string {
    return path.join(this.tempRoot, connectionId, key);
  }

  ensureParentDir(filePath: string): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  }

  registerMapping(localPath: string, connectionId: string, bucket: string, key: string): void {
    this.mappings.set(localPath, { localPath, connectionId, bucket, key });
  }

  getMapping(localPath: string): PreviewFileMapping | undefined {
    return this.mappings.get(localPath);
  }

  isTracked(localPath: string): boolean {
    return this.mappings.has(localPath);
  }

  getTempRoot(): string {
    return this.tempRoot;
  }
}
