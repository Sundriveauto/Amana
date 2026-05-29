import { PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "../lib/db";
import { appLogger } from "../middleware/logger";

interface HealthIndicatorResult {
    status: "up" | "down";
    message: string;
    responseTime: number;
}

interface HealthCheckResponse {
    status: "healthy" | "degraded" | "unhealthy";
    timestamp: string;
    uptime: number;
    checks: {
        database: HealthIndicatorResult;
        redis: HealthIndicatorResult;
        indexer: HealthIndicatorResult;
    };
    details: {
        databaseLatency: number;
        redisLatency: number;
        indexerLagSeconds: number;
        lastProcessedLedger: number | null;
    };
}

type HealthDatabase = any;
type HealthRedis = any;

export class HealthService {
    private startTime: number = Date.now();

    private redisClient: HealthRedis | null = null;
    private redisInitPromise: Promise<void> | null = null;

    constructor(
        private readonly prisma: HealthDatabase = defaultPrisma,
        redis?: HealthRedis,
    ) {
        if (redis !== undefined) {
            this.redisClient = redis;
        }
    }

    private async getRedis(): Promise<HealthRedis> {
        if (this.redisClient) {
            return this.redisClient;
        }
        if (!this.redisInitPromise) {
            this.redisInitPromise = (async () => {
                const { redis } = await import("../lib/redis");
                this.redisClient = redis;
            })();
        }
        await this.redisInitPromise;
        return this.redisClient!;
    }

    private async checkDatabase(): Promise<HealthIndicatorResult> {
        const startTime = Date.now();
        const timeout = 200;

        try {
            const result = await Promise.race([
                this.prisma.$queryRaw`SELECT 1 as health_check`,
                new Promise((_, reject) =>
                    setTimeout(() => reject(new Error("Database query timeout")), timeout)
                ),
            ]);

            const responseTime = Date.now() - startTime;

            if (responseTime > timeout) {
                return {
                    status: "down",
                    message: `Database query exceeded ${timeout}ms threshold`,
                    responseTime,
                };
            }

            return {
                status: "up",
                message: "Database connection healthy",
                responseTime,
            };
        } catch (error) {
            const responseTime = Date.now() - startTime;
            appLogger.error({ error }, "Database health check failed");
            return {
                status: "down",
                message: `Database check failed: ${error instanceof Error ? error.message : "Unknown error"}`,
                responseTime,
            };
        }
    }

    private async checkRedis(): Promise<HealthIndicatorResult> {
        const startTime = Date.now();
        const timeout = 200;

        try {
            const redis = await this.getRedis();
            await Promise.race([
                redis.ping(),
                new Promise((_, reject) =>
                    setTimeout(() => reject(new Error("Redis ping timeout")), timeout)
                ),
            ]);

            const responseTime = Date.now() - startTime;

            return {
                status: "up",
                message: "Redis connection healthy",
                responseTime,
            };
        } catch (error) {
            const responseTime = Date.now() - startTime;
            appLogger.error({ error }, "Redis health check failed");
            return {
                status: "down",
                message: `Redis check failed: ${error instanceof Error ? error.message : "Unknown error"}`,
                responseTime,
            };
        }
    }

    private async checkIndexer(): Promise<HealthIndicatorResult> {
        const startTime = Date.now();
        const maxLagSeconds = 15;

        try {
            const latestEvent = await this.prisma.processedEvent.findFirst({
                orderBy: { ledgerSequence: "desc" },
            });

            const responseTime = Date.now() - startTime;

            if (!latestEvent) {
                return {
                    status: "down",
                    message: "No processed events found - indexer may not have started",
                    responseTime,
                };
            }

            const eventAge = (Date.now() - latestEvent.processedAt.getTime()) / 1000;

            if (eventAge > maxLagSeconds) {
                return {
                    status: "down",
                    message: `Indexer lag exceeds ${maxLagSeconds}s threshold (current: ${eventAge.toFixed(1)}s)`,
                    responseTime,
                };
            }

            return {
                status: "up",
                message: `Indexer healthy - last event processed ${eventAge.toFixed(1)}s ago`,
                responseTime,
            };
        } catch (error) {
            const responseTime = Date.now() - startTime;
            appLogger.error({ error }, "Indexer health check failed");
            return {
                status: "down",
                message: `Indexer check failed: ${error instanceof Error ? error.message : "Unknown error"}`,
                responseTime,
            };
        }
    }

    async performHealthCheck(): Promise<HealthCheckResponse> {
        const timestamp = new Date().toISOString();
        const uptime = Date.now() - this.startTime;

        const [databaseCheck, redisCheck, indexerCheck] = await Promise.all([
            this.checkDatabase(),
            this.checkRedis(),
            this.checkIndexer(),
        ]);

        let status: "healthy" | "degraded" | "unhealthy" = "healthy";
        if (databaseCheck.status === "down" || redisCheck.status === "down" || indexerCheck.status === "down") {
            status = "unhealthy";
        } else if (databaseCheck.responseTime > 150 || redisCheck.responseTime > 150 || indexerCheck.responseTime > 150) {
            status = "degraded";
        }

        const latestEvent = await this.prisma.processedEvent.findFirst({
            orderBy: { ledgerSequence: "desc" },
        });

        const indexerLagSeconds = latestEvent
            ? (Date.now() - latestEvent.processedAt.getTime()) / 1000
            : -1;

        return {
            status,
            timestamp,
            uptime,
            checks: {
                database: databaseCheck,
                redis: redisCheck,
                indexer: indexerCheck,
            },
            details: {
                databaseLatency: databaseCheck.responseTime,
                redisLatency: redisCheck.responseTime,
                indexerLagSeconds: indexerLagSeconds > 0 ? indexerLagSeconds : 0,
                lastProcessedLedger: latestEvent?.ledgerSequence ?? null,
            },
        };
    }

    async performStartupCheck(): Promise<{ status: "ready" | "not_ready"; timestamp: string; checks: { database: HealthIndicatorResult; redis: HealthIndicatorResult } }> {
        const timestamp = new Date().toISOString();

        const [databaseCheck, redisCheck] = await Promise.all([
            this.checkDatabase(),
            this.checkRedis(),
        ]);

        const isReady = databaseCheck.status === "up" && redisCheck.status === "up";

        return {
            status: isReady ? "ready" : "not_ready",
            timestamp,
            checks: {
                database: databaseCheck,
                redis: redisCheck,
            },
        };
    }
}
