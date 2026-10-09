import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { contentDisposition, type FileStorage, type PresignedUpload } from './storage';

export interface S3Config {
  endpoint?: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** MinIO and most S3-compatible servers need path-style URLs. */
  forcePathStyle: boolean;
}

/** S3 or an S3-compatible server (MinIO). Uploads are size- and type-bound by the signature. */
export class S3FileStorage implements FileStorage {
  private readonly client: S3Client;

  constructor(private readonly config: S3Config) {
    this.client = new S3Client({
      region: config.region,
      ...(config.endpoint ? { endpoint: config.endpoint } : {}),
      forcePathStyle: config.forcePathStyle,
      credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    });
  }

  async presignPut(input: {
    key: string;
    contentType: string;
    sizeBytes: number;
    expiresIn: number;
  }): Promise<PresignedUpload> {
    const command = new PutObjectCommand({
      Bucket: this.config.bucket,
      Key: input.key,
      ContentType: input.contentType,
      ContentLength: input.sizeBytes,
    });
    const url = await getSignedUrl(this.client, command, {
      expiresIn: input.expiresIn,
      signableHeaders: new Set(['content-type', 'content-length']),
    });
    return { url, headers: { 'content-type': input.contentType } };
  }

  presignGet(input: {
    key: string;
    fileName: string;
    contentType: string;
    expiresIn: number;
  }): Promise<string> {
    const command = new GetObjectCommand({
      Bucket: this.config.bucket,
      Key: input.key,
      ResponseContentDisposition: contentDisposition(input.fileName),
      ResponseContentType: input.contentType,
    });
    return getSignedUrl(this.client, command, { expiresIn: input.expiresIn });
  }

  async head(key: string): Promise<{ sizeBytes: number } | null> {
    try {
      const out = await this.client.send(new HeadObjectCommand({ Bucket: this.config.bucket, Key: key }));
      return { sizeBytes: Number(out.ContentLength ?? 0) };
    } catch (error) {
      if ((error as { name?: string }).name === 'NotFound') return null;
      throw error;
    }
  }

  async read(key: string): Promise<Buffer> {
    const out = await this.client.send(new GetObjectCommand({ Bucket: this.config.bucket, Key: key }));
    return Buffer.from(await out.Body!.transformToByteArray());
  }

  async write(key: string, body: Buffer, contentType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({ Bucket: this.config.bucket, Key: key, Body: body, ContentType: contentType }),
    );
  }
}
