/**
 * Minimal end-to-end example.
 *
 * Creates a session + a campaign with 20 recipients and one text step,
 * then boots the engine and watches it dispatch through.
 */

import { PrismaClient } from '@prisma/client';
import {
  DispatchEngine,
  MockProvider,
  recoverStuckWork,
  Scheduler,
} from '../../src';

async function main() {
  const prisma = new PrismaClient();

  // Always run recovery on boot — safe to call even on a clean DB.
  await recoverStuckWork({ prisma });

  const mock = new MockProvider({ latencyMs: 50 });
  const engine = new DispatchEngine({
    prisma,
    providers: { whatsapp: mock },
  });

  const scheduler = new Scheduler({ prisma, engine, tickMs: 5_000 });
  scheduler.start();

  // Reset from previous runs of this example.
  await prisma.dispatchLog.deleteMany({});
  await prisma.campaignStep.deleteMany({});
  await prisma.campaignRecipient.deleteMany({});
  await prisma.campaign.deleteMany({});
  await prisma.session.deleteMany({});

  // 1. Session (the identity that owns the send)
  const session = await prisma.session.create({
    data: {
      name: 'demo-session',
      channel: 'whatsapp',
      status: 'CONNECTED',
    },
  });

  // 2. Campaign with compressed timings (so the example runs quickly)
  const campaign = await prisma.campaign.create({
    data: {
      name: 'Demo — welcome blast',
      sessionId: session.id,
      minInterval: 8,       // will be clamped to the floor
      maxInterval: 12,
      batchSize: 5,
      batchPause: 60,
      recipients: {
        create: Array.from({ length: 20 }, (_, i) => ({
          address: `+55119${String(10000000 + i).padStart(8, '0')}`,
          name: `Contact ${i + 1}`,
          order: i,
        })),
      },
      steps: {
        create: [
          {
            stepOrder: 0,
            name: 'Greeting',
            status: 'DRAFT',
            messageType: 'TEXT',
            messageText: 'Olá! Esta é uma mensagem da demo do dispatch engine.',
          },
        ],
      },
    },
    include: { steps: true },
  });

  console.log(`started campaign ${campaign.id} with ${campaign.totalRecipients || 20} recipients`);

  await engine.startCampaign(campaign.id);

  // Poll until completed
  const poll = setInterval(async () => {
    const c = await prisma.campaign.findUnique({ where: { id: campaign.id } });
    if (!c) return;
    console.log(`status=${c.status} sent=${c.sentCount} failed=${c.failedCount}`);
    if (c.status === 'COMPLETED' || c.status === 'FAILED') {
      clearInterval(poll);
      scheduler.stop();
      console.log(`total delivered via provider: ${mock.sent.length}`);
      await prisma.$disconnect();
      process.exit(0);
    }
  }, 3000);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
