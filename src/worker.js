import { Worker, UnrecoverableError } from 'bullmq';
import { config } from './config.js';
import { pool } from './db.js';
import { connection, enqueueReportJob } from './queue.js';

const worker = new Worker(
  'marketplace-reports',
  async (job) => {
    const { orderId } = job.data;

    const [orderRows] = await pool.query('SELECT * FROM orders WHERE id = ?', [orderId]);
    if (orderRows.length === 0) {
      throw new UnrecoverableError(`Order ${orderId} not found`);
    }

    const order = orderRows[0];
    if (order.report_status === 'REPORTED') {
      return { skipped: true, reason: 'Already reported' };
    }

    const [lineRows] = await pool.query(
      `SELECT p.sku
       FROM order_line ol
       JOIN product p ON p.id = ol.product_id
       WHERE ol.order_id = ?
       ORDER BY ol.id ASC`,
      [orderId]
    );

    const payload = {
      pickedAt: new Date(order.picked_at || Date.now()).toISOString(),
      lines: lineRows.map((r) => r.sku),
    };

    const url = `${config.marketplaceUrl}/orders/${encodeURIComponent(order.external_id)}/picked`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    let response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': `order-${order.external_id}`,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch (networkErr) {
      throw new Error(`Network/timeout error calling marketplace: ${networkErr.message}`);
    } finally {
      clearTimeout(timeout);
    }

    if (response.status === 200 || response.status === 409) {
      await pool.query(
        `UPDATE orders SET report_status = 'REPORTED', report_error = NULL WHERE id = ?`,
        [orderId]
      );
      return { status: response.status };
    }

    const responseText = await response.text().catch(() => '');

    if (response.status === 400) {
      const errorMsg = `Marketplace rejected report (400): ${responseText || 'Bad Request'}`;
      await pool.query(
        `UPDATE orders SET report_status = 'FAILED', report_error = ? WHERE id = ?`,
        [errorMsg, orderId]
      );
      throw new UnrecoverableError(errorMsg);
    }

    throw new Error(`Marketplace transient error (${response.status}): ${responseText}`);
  },
  {
    connection,
    concurrency: 5,
  }
);

worker.on('failed', async (job, err) => {
  if (!job) return;
  const maxAttempts = job.opts.attempts || 1;
  const isUnrecoverable = err instanceof UnrecoverableError || err.name === 'UnrecoverableError';

  if (isUnrecoverable || job.attemptsMade >= maxAttempts) {
    const { orderId } = job.data;
    await pool.query(
      `UPDATE orders 
       SET report_status = 'FAILED', report_error = ? 
       WHERE id = ? AND report_status != 'REPORTED'`,
      [err.message, orderId]
    );
  }
});

let recoveryRunning = false;

async function recoverPendingReports() {
  if (recoveryRunning) return;
  recoveryRunning = true;

  try {
    const [orders] = await pool.query(
      `SELECT id
       FROM orders
       WHERE status = 'PICKED' AND report_status = 'PENDING'
       ORDER BY id ASC`
    );

    for (const order of orders) {
      await enqueueReportJob(order.id);
    }
  } catch (err) {
    console.error('Pending report recovery error:', err);
  } finally {
    recoveryRunning = false;
  }
}

void recoverPendingReports();
const recoveryTimer = setInterval(() => void recoverPendingReports(), 5000);
recoveryTimer.unref();

console.log(`Worker listening and reporting to ${config.marketplaceUrl}`);
