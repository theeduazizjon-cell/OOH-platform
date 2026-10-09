import { Socket } from 'node:net';

export type ScanResult =
  { clean: true; engine: string } | { clean: false; engine: string; signature: string };

/** Virus scanning (08-system-architecture.md §4: ClamAV). Throws when the scanner can't be reached. */
export interface FileScanner {
  scan(body: Buffer): Promise<ScanResult>;
}

export const FILE_SCANNER = Symbol('FILE_SCANNER');

/** Development only (refused in production): records that nothing scanned the file. */
export class NoFileScanner implements FileScanner {
  scan(): Promise<ScanResult> {
    return Promise.resolve({ clean: true, engine: 'none' });
  }
}

/** clamd over TCP with the INSTREAM command (length-prefixed chunks, zero-length terminator). */
export class ClamdScanner implements FileScanner {
  constructor(
    private readonly host: string,
    private readonly port: number,
    private readonly timeoutMs = 60_000,
  ) {}

  scan(body: Buffer): Promise<ScanResult> {
    return new Promise((resolvePromise, reject) => {
      const socket = new Socket();
      const replies: Buffer[] = [];
      socket.setTimeout(this.timeoutMs, () => socket.destroy(new Error('clamd timed out')));
      socket.on('error', reject);
      socket.on('data', (chunk: Buffer) => replies.push(chunk));
      socket.on('end', () => {
        const reply = Buffer.concat(replies).toString().replace(/\0/g, '').trim();
        if (reply.endsWith('OK')) return resolvePromise({ clean: true, engine: 'clamav' });
        const found = /: (.+) FOUND$/.exec(reply);
        if (found) return resolvePromise({ clean: false, engine: 'clamav', signature: found[1]! });
        reject(new Error(`clamd: ${reply || 'no reply'}`));
      });
      socket.connect(this.port, this.host, () => {
        socket.write('zINSTREAM\0');
        const chunkSize = 64 * 1024;
        for (let offset = 0; offset < body.length; offset += chunkSize) {
          const chunk = body.subarray(offset, offset + chunkSize);
          const size = Buffer.alloc(4);
          size.writeUInt32BE(chunk.length);
          socket.write(size);
          socket.write(chunk);
        }
        socket.end(Buffer.alloc(4));
      });
    });
  }
}
