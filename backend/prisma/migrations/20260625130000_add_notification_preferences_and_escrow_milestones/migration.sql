-- User notification preferences and escrow partial release schedules.
-- Indexes match user-scoped reads and trade-scoped milestone validation.
CREATE TABLE "NotificationPreference" (
    "id" SERIAL NOT NULL,
    "userAddress" VARCHAR(255) NOT NULL,
    "preferences" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NotificationPreference_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "EscrowReleaseMilestone" (
    "id" SERIAL NOT NULL,
    "tradeId" VARCHAR(255) NOT NULL,
    "milestoneIndex" INTEGER NOT NULL,
    "amountUsdc" VARCHAR(100) NOT NULL,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "releasedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EscrowReleaseMilestone_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "NotificationPreference_userAddress_key" ON "NotificationPreference"("userAddress");
CREATE INDEX "NotificationPreference_userAddress_idx" ON "NotificationPreference"("userAddress");

CREATE UNIQUE INDEX "EscrowReleaseMilestone_tradeId_milestoneIndex_key"
  ON "EscrowReleaseMilestone"("tradeId", "milestoneIndex");
CREATE INDEX "EscrowReleaseMilestone_tradeId_dueAt_idx" ON "EscrowReleaseMilestone"("tradeId", "dueAt");
CREATE INDEX "EscrowReleaseMilestone_tradeId_releasedAt_idx" ON "EscrowReleaseMilestone"("tradeId", "releasedAt");

ALTER TABLE "NotificationPreference" ADD CONSTRAINT "NotificationPreference_userAddress_fkey"
  FOREIGN KEY ("userAddress") REFERENCES "User"("walletAddress") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "EscrowReleaseMilestone" ADD CONSTRAINT "EscrowReleaseMilestone_tradeId_fkey"
  FOREIGN KEY ("tradeId") REFERENCES "Trade"("tradeId") ON DELETE CASCADE ON UPDATE CASCADE;
