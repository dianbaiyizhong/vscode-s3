import * as fs from 'fs';
import {
  S3Client,
  HeadBucketCommand,
  ListObjectsV2Command,
  ListObjectsCommand,
  PutObjectCommand,
  GetObjectCommand,
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
  let commonPrefixes: { Prefix?: string }[] | undefined;
  let contents: { Key?: string; Size?: number; LastModified?: Date }[] | undefined;

  try {
    const response = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        Delimiter: '/',
        MaxKeys: 200,
      })
    );
    commonPrefixes = response.CommonPrefixes;
    contents = response.Contents;
  } catch {
    const response = await client.send(
      new ListObjectsCommand({
        Bucket: bucket,
        Prefix: prefix,
        Delimiter: '/',
        MaxKeys: 200,
      })
    );
    commonPrefixes = response.CommonPrefixes;
    contents = response.Contents;
  }

  const items: S3ObjectInfo[] = [];

  for (const cp of commonPrefixes || []) {
    if (cp.Prefix) {
      items.push({
        key: cp.Prefix,
        isFolder: true,
      });
    }
  }

  for (const obj of contents || []) {
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
