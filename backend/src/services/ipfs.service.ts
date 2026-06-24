import { Readable } from "stream";
import { getPinataClient } from "../config/ipfs";
import { retryAsync } from "../lib/retry";
import { appLogger } from "../middleware/logger";
import { TracingHelper } from "../config/tracing";
import { env } from "../config/env";
import {
  CircuitBreaker,
  CircuitBreakerOpenError,
} from "../lib/circuitBreaker";

export class ServiceUnavailableError extends Error {
    status = 503;
    constructor(message = "IPFS service unavailable. Please retry shortly.") {
        super(message);
        this.name = "ServiceUnavailableError";
    }
}

export class IPFSService {
    private pinataCircuit: CircuitBreaker;

    constructor() {
      this.pinataCircuit = new CircuitBreaker("pinata-ipfs", {
        failureThreshold: env.IPFS_PINATA_CIRCUIT_FAILURE_THRESHOLD,
        successThreshold: 2,
        cooldownMs: env.IPFS_PINATA_CIRCUIT_COOLDOWN_MS,
      });
    }

    private getUploadTimeoutMs(): number {
        return env.IPFS_UPLOAD_TIMEOUT_MS;
    }

    private async withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
        return await new Promise<T>((resolve, reject) => {
            const handle = setTimeout(() => reject(new Error("IPFS upload timeout")), timeoutMs);
            operation
                .then((value) => {
                    clearTimeout(handle);
                    resolve(value);
                })
                .catch((error) => {
                    clearTimeout(handle);
                    reject(error);
                });
        });
    }

    /**
     * Upload a file buffer to IPFS via Pinata and pin it.
     * @returns The IPFS CID string
     */
    async uploadFile(buffer: Buffer, filename: string): Promise<string> {
        try {
          return await this.pinataCircuit.call(async () => {
            const pinata = getPinataClient();

            return TracingHelper.withSpan(
                "ipfs.upload_file",
                async (span) => {
                    span.setAttributes({
                        'ipfs.operation': 'upload_file',
                        'ipfs.filename': filename,
                        'ipfs.file_size': buffer.length,
                    });

                    const stream = Readable.from(buffer) as unknown as NodeJS.ReadableStream & { path: string };
                    stream.path = filename;

                    TracingHelper.addEvent('ipfs_upload_start', { filename, size: buffer.length });

                    try {
                        const timeoutMs = this.getUploadTimeoutMs();
                        const result = await retryAsync(() =>
                            this.withTimeout(
                                pinata.pinFileToIPFS(stream, {
                                    pinataMetadata: { name: filename },
                                    pinataOptions: { cidVersion: 1 },
                                }),
                                timeoutMs,
                            )
                        );

                        span.setAttributes({
                            'ipfs.cid': result.IpfsHash,
                            'ipfs.upload_success': true,
                        });

                        TracingHelper.addEvent('ipfs_upload_success', { 
                            cid: result.IpfsHash,
                            filename 
                        });

                        appLogger.info(
                            { 
                                cid: result.IpfsHash, 
                                filename, 
                                size: buffer.length 
                            }, 
                            "[IPFSService] File uploaded successfully"
                        );

                        return result.IpfsHash;
                    } catch (err) {
                        span.setAttributes({
                            'ipfs.upload_success': false,
                            'ipfs.error': err instanceof Error ? err.message : 'Unknown error',
                        });

                        TracingHelper.addEvent('ipfs_upload_error', { 
                            error: err instanceof Error ? err.message : 'Unknown error',
                            filename 
                        });

                        appLogger.error({ err, filename }, "[IPFSService] Pinata upload failed");
                        throw new ServiceUnavailableError();
                    }
                },
                {
                    attributes: {
                        'service.name': 'ipfs',
                        'operation.type': 'external_service',
                    }
                }
            );
          });
        } catch (err) {
          if (err instanceof CircuitBreakerOpenError) {
            throw new ServiceUnavailableError("IPFS upload circuit is temporarily open");
          }
          throw err;
        }
    }

    /**
     * Build a public gateway URL for a given CID.
     */
    getFileUrl(cid: string): string {
        const gateway = process.env.IPFS_GATEWAY_URL ?? env.IPFS_GATEWAY_URL;
        return `${gateway.replace(/\/$/, "")}/${cid}`;
    }
}
