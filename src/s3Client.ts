import * as fs from 'fs';
import * as path from 'path';
import * as stream from 'stream';
import {
  S3Client,
  HeadBucketCommand,
  HeadObjectCommand,
  GetObjectTaggingCommand,
  ListObjectsV2Command,
  ListObjectsCommand,
  PutObjectCommand,
  GetObjectCommand,
  CopyObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  ObjectIdentifier,
  ListMultipartUploadsCommand,
  AbortMultipartUploadCommand,
} from '@aws-sdk/client-s3';
import { S3Connection } from './connectionManager';
import { HttpProxyAgent } from 'http-proxy-agent';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { Upload } from '@aws-sdk/lib-storage';

export interface IObjectClient {
  send(command: any): Promise<any>;
}

class ObsClientWrapper implements IObjectClient {
  private client: any;

  constructor(connection: S3Connection) {
    const ObsClient = require('esdk-obs-nodejs');
    this.client = new ObsClient({
      access_key_id: connection.accessKeyId,
      secret_access_key: connection.secretAccessKey,
      server: connection.endpoint,
      ...(connection.region ? { region: connection.region } : {}),
      ...(connection.forcePathStyle ? { path_style: true } : {}),
      socketTimeout: 3600000,
    });
  }

  async send(command: any): Promise<any> {
    const name: string = command.constructor.name || '';
    const input = command.input || {};

    if (name.includes('GetObjectTagging'))
      return { TagSet: [] };

    if (name.includes('ListObjectsV2')) {
      const result = await this.client.listObjects({
        ...input,
        Marker: input.ContinuationToken || input.StartAfter,
      });
      const common = result.CommonMsg || {};
      if (common.Status >= 300) this.throwError(common);
      const data = result.InterfaceResult || result;
      return {
        ...data,
        IsTruncated: data.IsTruncated === true || data.IsTruncated === 'true',
        NextContinuationToken: data.NextMarker,
        CommonPrefixes: data.CommonPrefixes || [],
        Contents: data.Contents || [],
      };
    }
    if (name.includes('ListObjects')) {
      const result = await this.client.listObjects(input);
      const common = result.CommonMsg || {};
      if (common.Status >= 300) this.throwError(common);
      const data = result.InterfaceResult || result;
      return {
        ...data,
        IsTruncated: data.IsTruncated === true || data.IsTruncated === 'true',
        CommonPrefixes: data.CommonPrefixes || [],
        Contents: data.Contents || [],
      };
    }
    if (name.includes('DeleteObjects')) {
      const result = await this.client.deleteObjects({
        Bucket: input.Bucket,
        Objects: input.Delete?.Objects,
        Quiet: input.Delete?.Quiet,
      });
      const common = result.CommonMsg || {};
      if (common.Status >= 300) this.throwError(common);
      return result.InterfaceResult || result;
    }
    if (name.includes('HeadBucket')) {
      const result = await this.client.headBucket(input);
      const common = result.CommonMsg || {};
      if (common.Status >= 300) this.throwError(common);
      return result;
    }
    if (name.includes('HeadObject')) {
      const result = await this.client.getObjectMetadata(input);
      const common = result.CommonMsg || {};
      if (common.Status >= 300) this.throwError(common);
      return result.InterfaceResult || result;
    }
    if (name.includes('PutObject')) {
      const body = input.Body;
      const result = await this.client.putObject({
        ...input,
        Body: body && Buffer.isBuffer(body) ? stream.Readable.from(body) : body,
      });
      const common = result.CommonMsg || {};
      if (common.Status >= 300) this.throwError(common);
      return result.InterfaceResult || result;
    }
    if (name.includes('GetObject')) {
      const result = await this.client.getObject(Object.assign({}, input, { SaveAsStream: true }));
      const common = result.CommonMsg || {};
      if (common.Status >= 300) this.throwError(common);
      const data = result.InterfaceResult || result;
      // OBS SDK stores the body under 'Content' (model param name), not 'Body' — remap
      if (!data.Body && data.Content) {
        data.Body = data.Content;
      }
      if (data.Body) {
        if (typeof data.Body.pipe === 'function') {
          // Already a stream from OBS SDK (SaveAsStream:true) — pass through
        } else if (typeof data.Body[Symbol.asyncIterator] !== 'function') {
          data.Body = (async function* () { yield data.Body; })();
        }
      } else {
        throw new Error('Empty response body');
      }
      return data;
    }
    if (name.includes('CopyObject')) {
      const result = await this.client.copyObject(input);
      const common = result.CommonMsg || {};
      if (common.Status >= 300) this.throwError(common);
      return result.InterfaceResult || result;
    }
    if (name.includes('DeleteObject')) {
      const result = await this.client.deleteObject(input);
      const common = result.CommonMsg || {};
      if (common.Status >= 300) this.throwError(common);
      return result.InterfaceResult || result;
    }

    throw new Error(`Huawei OBS: unsupported command ${name}`);
  }

  private throwError(common: { Status?: number; Code?: string; Message?: string }): never {
    const err = new Error(common.Message || `OBS Error ${common.Status}`);
    (err as any).name = common.Code || 'OBSRequestError';
    (err as any).$metadata = { httpStatusCode: common.Status };
    throw err;
  }
}

export function createClient(connection: S3Connection): IObjectClient {
  if (connection.isHuaweiOBS) {
    return new ObsClientWrapper(connection);
  }
  const config: ConstructorParameters<typeof S3Client>[0] = {
    endpoint: connection.endpoint,
    region: connection.region,
    credentials: {
      accessKeyId: connection.accessKeyId,
      secretAccessKey: connection.secretAccessKey,
    },
    forcePathStyle: connection.forcePathStyle,
  };

  let proxyUrl = '';
  let noProxy = '';

  if (connection.proxyEnabled && connection.proxyUrl) {
    proxyUrl = connection.proxyUrl;
    if (connection.proxyUsername) {
      const url = new URL(proxyUrl);
      url.username = connection.proxyUsername;
      if (connection.proxyPassword) url.password = connection.proxyPassword;
      proxyUrl = url.toString().replace(/\/$/, '');
    }
    noProxy = connection.noProxy || '';
  }

  if (!proxyUrl) {
    proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy
      || process.env.HTTP_PROXY || process.env.http_proxy
      || '';
    noProxy = process.env.NO_PROXY || process.env.no_proxy || '';
  }

  if (proxyUrl) {
    const endpointUrl = new URL(connection.endpoint);
    const shouldProxy = !noProxy || !noProxy.split(',').some(pattern => {
      const p = pattern.trim();
      return p && (endpointUrl.hostname === p || endpointUrl.hostname.endsWith('.' + p));
    });

    if (shouldProxy) {
      config.requestHandler = {
        httpAgent: new HttpProxyAgent(proxyUrl),
        httpsAgent: new HttpsProxyAgent(proxyUrl),
      };
    }
  }

  return new S3Client(config);
}

export type ProgressFn = (pct: number, loaded: number, total: number) => void;

export interface S3ObjectInfo {
  key: string;
  isFolder: boolean;
  size?: number;
  lastModified?: Date;
}

function getLastKey(response: { CommonPrefixes?: { Prefix?:string }[]; Contents?: { Key?:string }[] }): string | undefined {
  const contents = response.Contents || [];
  if (contents.length > 0) {
    return contents[contents.length - 1].Key;
  }
  const prefixes = response.CommonPrefixes || [];
  if (prefixes.length > 0) {
    return prefixes[prefixes.length - 1].Prefix;
  }
}

export async function listObjects(
  client: IObjectClient,
  bucket: string,
  prefix: string = '',
  maxPages: number = 1,
  targetKey?: string,
  startAfter?: string,
  maxKeys?: number,
): Promise<{ items: S3ObjectInfo[]; nextToken?: string }> {
  const allCommonPrefixes: { Prefix?: string }[] = [];
  const allContents: { Key?: string; Size?: number; LastModified?: Date }[] = [];

  let cursor: string | undefined = startAfter;
  let useV1 = false;
  let pageCount = 0;
  let isTruncated = false;

  const mk = maxKeys ?? 100;
  const hasMaxPages = maxPages > 0 && !targetKey;
  while (!hasMaxPages || pageCount < maxPages) {
    pageCount++;
    try {
      if (useV1) {
        const response = await client.send(
          new ListObjectsCommand({
            Bucket: bucket,
            Prefix: prefix,
            Delimiter: '/',
            MaxKeys: mk,
            Marker: cursor,
          })
        );
        if (response.CommonPrefixes) {
          allCommonPrefixes.push(...response.CommonPrefixes);
        }
        if (response.Contents) {
          allContents.push(...response.Contents);
        }
        if (!response.IsTruncated) break;
        isTruncated = true;
        cursor = response.NextMarker || getLastKey(response);
        if (!cursor) break;
      } else {
        const response = await client.send(
          new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: prefix,
            Delimiter: '/',
            MaxKeys: mk,
            ...(cursor ? { ContinuationToken: cursor } : {}),
          })
        );
        if (response.CommonPrefixes) {
          allCommonPrefixes.push(...response.CommonPrefixes);
        }
        if (response.Contents) {
          allContents.push(...response.Contents);
        }
        if (!response.IsTruncated) break;
        isTruncated = true;
        cursor = response.NextContinuationToken || response.NextMarker || getLastKey(response);
        if (!cursor) break;
      }
    } catch {
      useV1 = true;
    }

    if (targetKey) {
      const found = allCommonPrefixes.some(cp => cp.Prefix === targetKey) ||
        allContents.some(obj => obj.Key === targetKey);
      if (found) break;
    }
  }

  const items: S3ObjectInfo[] = [];

  for (const cp of allCommonPrefixes) {
    if (cp.Prefix) {
      items.push({ key: cp.Prefix, isFolder: true });
    }
  }

  for (const obj of allContents) {
    if (!obj.Key) continue;
    if (obj.Key.endsWith('/')) continue;
    items.push({
      key: obj.Key,
      isFolder: false,
      size: Number(obj.Size) || 0,
      lastModified: obj.LastModified,
    });
  }

  items.sort((a, b) => {
    if (a.isFolder !== b.isFolder) return a.isFolder ? -1 : 1;
    return a.key.localeCompare(b.key);
  });

  return { items, nextToken: isTruncated ? cursor : undefined };
}

export async function uploadFile(
  client: IObjectClient,
  bucket: string,
  key: string,
  localFilePath: string,
  contentLength?: number,
  onProgress?: ProgressFn
): Promise<void> {
  const totalSize = contentLength ?? (await fs.promises.stat(localFilePath)).size;
  const createStream = () => fs.createReadStream(localFilePath, { highWaterMark: 1024 * 1024 * 16 });

  if (client instanceof ObsClientWrapper) {
    const obsClient = (client as any).client;
    // Use OBS SDK uploadFile (multipart) for reliable uploads with timeout resilience
    if (typeof obsClient?.uploadFile === 'function') {
      await new Promise<void>((resolve, reject) => {
        obsClient.uploadFile({
          Bucket: bucket,
          Key: key,
          UploadFile: localFilePath,
          PartSize: 5 * 1024 * 1024,
          ProgressCallback: onProgress ? (transferredBytes: number, totalBytes: number) => {
            const transferred = transferredBytes || 0;
            const total = totalBytes || totalSize;
            onProgress(Math.round(transferred / total * 100), transferred, total);
          } : undefined,
        }, (err: any, result: any) => {
          if (err) {
            const msg = err.Message || err.message || String(err);
            reject(new Error(msg));
          } else {
            resolve();
          }
        });
      });
    } else {
      let loaded = 0;
      const rs = createStream();
      if (onProgress) {
        rs.on('data', (chunk: Buffer) => {
          loaded += chunk.length;
          onProgress(Math.round(loaded / totalSize * 100), loaded, totalSize);
        });
      }
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: rs,
          ContentLength: totalSize,
        })
      );
    }
  } else {
    const upload = new Upload({
      client: client as any,
      params: {
        Bucket: bucket,
        Key: key,
        Body: createStream(),
      },
      queueSize: 4,
      partSize: 1024 * 1024 * 16,
      leavePartsOnError: false,
    });
    if (onProgress) {
      upload.on('httpUploadProgress', (p: { loaded?: number; total?: number }) => {
        const loaded = p.loaded ?? 0;
        const total = p.total ?? totalSize;
        onProgress(Math.round(loaded / total * 100), loaded, total);
      });
    }
    await upload.done();
  }
}

export async function downloadFile(
  client: IObjectClient,
  bucket: string,
  key: string,
  destinationPath: string,
  onProgress?: ProgressFn
): Promise<void> {
  const response = await client.send(
    new GetObjectCommand({
      Bucket: bucket,
      Key: key,
    })
  );

  const body = response.Body;
  if (!body) throw new Error('Empty response body');

  const contentLength = response.ContentLength as number | undefined;
  await fs.promises.mkdir(path.dirname(destinationPath), { recursive: true });

  // Normalise any body type into a Readable stream
  let readable: stream.Readable;
  if (typeof body[Symbol.asyncIterator] === 'function') {
    readable = stream.Readable.from(body);
  } else if (typeof (body as any).pipe === 'function') {
    readable = body as stream.Readable;
  } else if (Buffer.isBuffer(body)) {
    readable = stream.Readable.from([body]);
  } else {
    readable = stream.Readable.from([Buffer.from(String(body))]);
  }

  const writeStream = fs.createWriteStream(destinationPath);
  let loaded = 0;

  if (onProgress && contentLength && contentLength > 0) {
    readable.on('data', (chunk: Buffer) => {
      loaded += chunk.length;
      onProgress(Math.round(loaded / contentLength * 100), loaded, contentLength);
    });
  }

  await new Promise<void>((resolve, reject) => {
    readable.on('error', reject);
    writeStream.on('error', reject);
    writeStream.on('finish', resolve);
    readable.pipe(writeStream);
  });
}

export async function downloadFolder(
  client: IObjectClient,
  bucket: string,
  prefix: string,
  destinationDir: string,
  onProgress?: (current: number, total: number, key: string) => void
): Promise<{ success: number; fail: number }> {
  const files: string[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 200; i++) {
    const response = await client.send(new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: prefix,
      MaxKeys: 1000,
      ...(cursor ? { StartAfter: cursor } : {}),
    }));
    const contents = response.Contents || [];
    for (const obj of contents) {
      if (obj.Key && !obj.Key.endsWith('/')) {
        files.push(obj.Key);
      }
    }
    if (!response.IsTruncated) break;
    cursor = contents[contents.length - 1]?.Key;
    if (!cursor) break;
  }

  let success = 0;
  let fail = 0;
  for (let i = 0; i < files.length; i++) {
    const key = files[i];
    const relativePath = key.startsWith(prefix) ? key.slice(prefix.length) : key;
    const destPath = path.join(destinationDir, relativePath);
    try {
      const body = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      const chunks: Uint8Array[] = [];
      for await (const chunk of (body.Body || new Uint8Array()) as any) {
        chunks.push(chunk);
      }
      await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
      await fs.promises.writeFile(destPath, Buffer.concat(chunks));
      success++;
    } catch {
      fail++;
    }
    onProgress?.(i + 1, files.length, key);
  }
  return { success, fail };
}

export async function deleteObject(
  client: IObjectClient,
  bucket: string,
  key: string
): Promise<void> {
  await client.send(
    new DeleteObjectCommand({
      Bucket: bucket,
      Key: key,
    })
  );
}

export async function deleteFolder(
  client: IObjectClient,
  bucket: string,
  prefix: string
): Promise<void> {
  let continuationToken: string | undefined;

  while (true) {
    let objects: { Key?: string }[] | undefined;
    let truncated: boolean | undefined;
    let nextToken: string | undefined;

    try {
      const response = await client.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        })
      );
      objects = response.Contents;
      truncated = response.IsTruncated;
      nextToken = response.NextContinuationToken;
    } catch {
      const response = await client.send(
        new ListObjectsCommand({
          Bucket: bucket,
          Prefix: prefix,
          Marker: continuationToken,
        })
      );
      objects = response.Contents;
      truncated = response.IsTruncated;
      nextToken = response.NextMarker;
    }

    if (!objects || objects.length === 0) break;

    const objectIds: ObjectIdentifier[] = [];
    for (const obj of objects) {
      if (obj.Key) {
        objectIds.push({ Key: obj.Key });
      }
    }

    if (objectIds.length > 0) {
      await client.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: {
            Objects: objectIds,
            Quiet: true,
          },
        })
      );
    }

    if (!truncated) break;
    continuationToken = nextToken;
  }
}

export async function renameObject(
  client: IObjectClient,
  bucket: string,
  oldKey: string,
  newKey: string
): Promise<void> {
  await client.send(
    new CopyObjectCommand({
      Bucket: bucket,
      CopySource: `/${bucket}/${oldKey}`,
      Key: newKey,
    })
  );
  await client.send(
    new DeleteObjectCommand({
      Bucket: bucket,
      Key: oldKey,
    })
  );
}

export async function renameFolder(
  client: IObjectClient,
  bucket: string,
  oldPrefix: string,
  newPrefix: string
): Promise<void> {
  let continuationToken: string | undefined;
  const objectsToCopy: { oldKey: string; newKey: string }[] = [];

  while (true) {
    let objects: { Key?: string }[] | undefined;
    let truncated: boolean | undefined;
    let nextToken: string | undefined;

    try {
      const response = await client.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: oldPrefix,
          ContinuationToken: continuationToken,
        })
      );
      objects = response.Contents;
      truncated = response.IsTruncated;
      nextToken = response.NextContinuationToken;
    } catch {
      const response = await client.send(
        new ListObjectsCommand({
          Bucket: bucket,
          Prefix: oldPrefix,
          Marker: continuationToken,
        })
      );
      objects = response.Contents;
      truncated = response.IsTruncated;
      nextToken = response.IsTruncated ? response.NextMarker : undefined;
    }

    if (!objects || objects.length === 0) break;

    for (const obj of objects) {
      if (obj.Key) {
        const newObjKey = newPrefix + obj.Key.slice(oldPrefix.length);
        objectsToCopy.push({ oldKey: obj.Key, newKey: newObjKey });
      }
    }

    if (!truncated) break;
    continuationToken = nextToken;
  }

  for (const { oldKey, newKey } of objectsToCopy) {
    await client.send(
      new CopyObjectCommand({
        Bucket: bucket,
        CopySource: `/${bucket}/${oldKey}`,
        Key: newKey,
      })
    );
  }

  if (objectsToCopy.length > 0) {
    const objectIds: ObjectIdentifier[] = objectsToCopy.map(({ oldKey }) => ({ Key: oldKey }));
    await client.send(
      new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: { Objects: objectIds, Quiet: true },
      })
    );
  }
}

export async function createFolder(
  client: IObjectClient,
  bucket: string,
  key: string
): Promise<void> {
  const folderKey = key.endsWith('/') ? key : key + '/';
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: folderKey,
      Body: '',
    })
  );
}

export interface ObjectDetail {
  key: string;
  size?: number;
  etag?: string;
  contentType?: string;
  lastModified?: Date;
  metadata?: Record<string, string>;
  tags?: { key: string; value: string }[];
}

export async function getObjectDetail(
  client: IObjectClient,
  bucket: string,
  key: string
): Promise<ObjectDetail> {
  const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
  let tags: { key: string; value: string }[] = [];
  try {
    const tagResult = await client.send(new GetObjectTaggingCommand({ Bucket: bucket, Key: key }));
    tags = (tagResult.TagSet || []).map(t => ({ key: t.Key!, value: t.Value! }));
  } catch {}
  return {
    key,
    size: head.ContentLength,
    etag: head.ETag?.replace(/"/g, ''),
    contentType: head.ContentType,
    lastModified: head.LastModified,
    metadata: head.Metadata,
    tags,
  };
}

export async function putObjectTags(
  client: IObjectClient,
  bucket: string,
  key: string,
  tags: { key: string; value: string }[]
): Promise<void> {
  // Two-step copy via temp key to safely set tags on all S3-compatible
  // stores (MinIO: PutObjectTagging corrupts content, CopyObject ignores
  // TaggingDirective on self-copy; OBS: PutObjectTagging unsupported).
  const tempKey = key + '.s3btmp.' + Date.now() + '.' + Math.random().toString(36).slice(2, 6);

  await client.send(new CopyObjectCommand({
    Bucket: bucket, Key: tempKey, CopySource: `/${bucket}/${key}`,
  }));

  try {
    // Manually build the x-amz-tagging header to avoid SDK serialization bugs
    // (some MinIO versions reject the header generated by CopyObjectCommand).
    const tagString = tags.map(t =>
      `${encodeURIComponent(t.key)}=${encodeURIComponent(t.value)}`
    ).join('&');
    const cmd = new CopyObjectCommand({
      Bucket: bucket, Key: key, CopySource: `/${bucket}/${tempKey}`,
      MetadataDirective: 'COPY',
    });
    cmd.middlewareStack.addRelativeTo(
      (next: any, _ctx: any) => async (args: any) => {
        args.request.headers['x-amz-tagging'] = tagString;
        args.request.headers['x-amz-tagging-directive'] = 'REPLACE';
        return next(args);
      },
      { relation: 'after' as any, toMiddleware: 'serializerMiddleware' }
    );
    await client.send(cmd);
  } finally {
    try { await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: tempKey })); } catch {}
  }
}

export async function changeStorageClass(
  client: IObjectClient,
  bucket: string,
  key: string,
  storageClass: string
): Promise<void> {
  await client.send(new CopyObjectCommand({
    Bucket: bucket,
    Key: key,
    CopySource: `/${bucket}/${key}`,
    StorageClass: storageClass,
    MetadataDirective: 'COPY',
    TaggingDirective: 'COPY',
  }));
}

export async function copyObject(
  client: IObjectClient,
  sourceBucket: string,
  sourceKey: string,
  destBucket: string,
  destKey: string
): Promise<void> {
  await client.send(new CopyObjectCommand({
    Bucket: destBucket,
    Key: destKey,
    CopySource: `/${sourceBucket}/${sourceKey}`,
    MetadataDirective: 'COPY',
    TaggingDirective: 'COPY',
  }));
}

export async function listMultipartUploads(
  client: IObjectClient,
  bucket: string,
  prefix?: string
): Promise<{ uploadId: string; key: string; initiated: Date; }[]> {
  const result = await client.send(new ListMultipartUploadsCommand({
    Bucket: bucket,
    Prefix: prefix,
  }));
  return (result.Uploads || []).map((u: any) => ({
    uploadId: u.UploadId!,
    key: u.Key!,
    initiated: u.Initiated!,
  }));
}

export async function abortMultipartUpload(
  client: IObjectClient,
  bucket: string,
  key: string,
  uploadId: string
): Promise<void> {
  await client.send(new AbortMultipartUploadCommand({
    Bucket: bucket,
    Key: key,
    UploadId: uploadId,
  }));
}

export interface BucketInfo {
  totalObjects: number;
  totalSize: number;
  buckets?: string[];
}

export async function getBucketInfo(client: IObjectClient, bucket: string): Promise<BucketInfo> {
  let totalObjects = 0;
  let totalSize = 0;
  let cursor: string | undefined;
  for (let i = 0; i < 200; i++) {
    const response = await client.send(new ListObjectsV2Command({
      Bucket: bucket,
      MaxKeys: 1000,
      ...(cursor ? { StartAfter: cursor } : {}),
    }));
    const contents = response.Contents || [];
    totalObjects += contents.length;
    for (const obj of contents) {
      totalSize += Number(obj.Size) || 0;
    }
    if (!response.IsTruncated) break;
    cursor = contents[contents.length - 1]?.Key;
    if (!cursor) break;
  }
  return { totalObjects, totalSize };
}

export async function getFolderInfo(client: IObjectClient, bucket: string, prefix: string): Promise<{ totalObjects: number; totalSize: number }> {
  let totalObjects = 0;
  let totalSize = 0;
  let cursor: string | undefined;
  for (let i = 0; i < 200; i++) {
    const response = await client.send(new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: prefix,
      MaxKeys: 1000,
      ...(cursor ? { StartAfter: cursor } : {}),
    }));
    const contents = response.Contents || [];
    totalObjects += contents.length;
    for (const obj of contents) {
      totalSize += Number(obj.Size) || 0;
    }
    if (!response.IsTruncated) break;
    cursor = contents[contents.length - 1]?.Key;
    if (!cursor) break;
  }
  return { totalObjects, totalSize };
}

export async function testConnection(
  client: IObjectClient,
  bucket: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
    return { ok: true };
  } catch (e: any) {
    const name = e.name ? `[${e.name}]` : '';
    const message = e.message || String(e);
    const statusCode = e.$metadata?.httpStatusCode ? ` (HTTP ${e.$metadata.httpStatusCode})` : '';
    return { ok: false, error: `${name} ${message}${statusCode}`.trim() };
  }
}
