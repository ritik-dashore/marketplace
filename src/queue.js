import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { config } from './config.js';

export const connection = new IORedis(config.redisUrl, {
  maxRetriesPerRequest: null,
});

export const reportQueue = new Queue('marketplace-reports', {
  connection,
  defaultJobOptions: {
    attempts: 5,
    backoff: {
      type: 'exponential',
      delay: 1000,
    },
    removeOnComplete: 1000,
    removeOnFail: 5000,
  },
});

export async function enqueueReportJob(orderId, attemptSuffix = '') {
  const jobId = attemptSuffix
    ? `report-${orderId}-${attemptSuffix}`
    : `report-${orderId}`;
  await reportQueue.add('send-report', { orderId }, { jobId });
}
