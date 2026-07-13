import * as fs from 'fs';
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
} from '@aws-sdk/client-s3';
import { S3Connection } from './connectionManager';
import { HttpProxyAgent } from 'http-proxy-agent';
import { HttpsProxyAgent } from 'https-proxy-agent';

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
      const result = await this.client.getObject(input);
      const common = result.CommonMsg || {};
      if (common.Status >= 300) this.throwError(common);
      const data = result.InterfaceResult || result;
      if (data.Body && typeof data.Body.pipe !== 'function' && typeof data.Body[Symbol.asyncIterator] !== 'function') {
        data.Body = (async function* () { yield data.Body; })();
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
  localFilePath: string
): Promise<void> {
  const fileBuffer = await fs.promises.readFile(localFilePath);
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: fileBuffer,
    })
  );
}

export async function downloadFile(
  client: IObjectClient,
  bucket: string,
  key: string,
  destinationPath: string
): Promise<void> {
  const response = await client.send(
    new GetObjectCommand({
      Bucket: bucket,
      Key: key,
    })
  );

  const body = response.Body;
  if (!body) throw new Error('Empty response body');

  const chunks: Uint8Array[] = [];
  for await (const chunk of body as any) {
    chunks.push(chunk);
  }
  const buffer = Buffer.concat(chunks);
  await fs.promises.writeFile(destinationPath, buffer);
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
