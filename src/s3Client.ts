import * as fs from 'fs';
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
import { S3Connection, S3ConnectionSecrets } from './connectionManager';

export function createClient(connection: S3Connection, secrets: S3ConnectionSecrets): S3Client {
  return new S3Client({
    endpoint: connection.endpoint,
    region: connection.region,
    credentials: {
      accessKeyId: secrets.accessKeyId,
      secretAccessKey: secrets.secretAccessKey,
    },
    forcePathStyle: connection.forcePathStyle,
  });
}

export interface S3ObjectInfo {
  key: string;
  isFolder: boolean;
  size?: number;
  lastModified?: Date;
}

export async function listObjects(
  client: S3Client,
  bucket: string,
  prefix: string = ''
): Promise<S3ObjectInfo[]> {
  const allCommonPrefixes: { Prefix?: string }[] = [];
  const allContents: { Key?: string; Size?: number; LastModified?: Date }[] = [];

  let continuationToken: string | undefined;

  while (true) {
    try {
      const response = await client.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: prefix,
          Delimiter: '/',
          MaxKeys: 200,
          ContinuationToken: continuationToken,
        })
      );
      if (response.CommonPrefixes) {
        allCommonPrefixes.push(...response.CommonPrefixes);
      }
      if (response.Contents) {
        allContents.push(...response.Contents);
      }
      if (!response.IsTruncated) break;
      continuationToken = response.NextContinuationToken;
    } catch {
      const response = await client.send(
        new ListObjectsCommand({
          Bucket: bucket,
          Prefix: prefix,
          Delimiter: '/',
          MaxKeys: 200,
          Marker: continuationToken,
        })
      );
      if (response.CommonPrefixes) {
        allCommonPrefixes.push(...response.CommonPrefixes);
      }
      if (response.Contents) {
        allContents.push(...response.Contents);
      }
      if (!response.IsTruncated) break;
      continuationToken = response.NextMarker || response.Contents?.slice(-1)[0]?.Key;
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
    if (obj.Key === prefix) continue;
    if (obj.Key.endsWith('/')) continue;
    items.push({
      key: obj.Key,
      isFolder: false,
      size: obj.Size,
      lastModified: obj.LastModified,
    });
  }

  items.sort((a, b) => {
    if (a.isFolder !== b.isFolder) return a.isFolder ? -1 : 1;
    return a.key.localeCompare(b.key);
  });

  return items;
}

export async function uploadFile(
  client: S3Client,
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
  client: S3Client,
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
  client: S3Client,
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
  client: S3Client,
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
  client: S3Client,
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
  client: S3Client,
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
  client: S3Client,
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
  client: S3Client,
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

export async function testConnection(
  client: S3Client,
  bucket: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e.message || String(e) };
  }
}
