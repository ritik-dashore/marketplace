import express from 'express';
import { pathToFileURL } from 'node:url';
import { config } from './config.js';
import { pool, withTransaction } from './db.js';
import { enqueueReportJob } from './queue.js';

const app = express();
app.use(express.json());


function requireUser(req, res, next) {
  const userId = req.header('X-User-Id')?.trim();
  if (!userId) {
    return res.status(401).json({ error: 'Missing X-User-Id header' });
  }
  req.userId = userId;
  next();
}


app.post('/orders/:id/claim', requireUser, async (req, res) => {
  const orderId = req.params.id;
  const userId = req.userId;

  try {
    const outcome = await withTransaction(async (conn) => {
      const [rows] = await conn.query(
        'SELECT * FROM orders WHERE id = ? FOR UPDATE',
        [orderId]
      );
      if (rows.length === 0) {
        return { status: 404, body: { error: 'Order not found' } };
      }

      const order = rows[0];
      if (order.payment_status !== 'PAID') {
        return { status: 400, body: { error: 'Order is unpaid' } };
      }
      if (order.status === 'PICKED') {
        return { status: 400, body: { error: 'Order is already picked' } };
      }

      const now = new Date();
      const lockActive =
        order.locked_by &&
        order.locked_until &&
        new Date(order.locked_until) > now;

      if (lockActive && order.locked_by !== userId) {
        return {
          status: 409,
          body: {
            error: 'Order is locked by another picker',
            heldBy: order.locked_by,
            lockedUntil: new Date(order.locked_until).toISOString(),
          },
        };
      }

      const lockedUntil = new Date(now.getTime() + config.pickLockTtlSeconds * 1000);
      await conn.query(
        'UPDATE orders SET locked_by = ?, locked_until = ? WHERE id = ?',
        [userId, lockedUntil, orderId]
      );

      return {
        status: 200,
        body: {
          orderId: order.id,
          heldBy: userId,
          lockedUntil: lockedUntil.toISOString(),
        },
      };
    });

    return res.status(outcome.status).json(outcome.body);
  } catch (err) {
    console.error('Claim error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/orders/:id/release', requireUser, async (req, res) => {
  const orderId = req.params.id;
  const userId = req.userId;

  try {
    const outcome = await withTransaction(async (conn) => {
      const [rows] = await conn.query(
        'SELECT * FROM orders WHERE id = ? FOR UPDATE',
        [orderId]
      );
      if (rows.length === 0) {
        return { status: 404, body: { error: 'Order not found' } };
      }

      const order = rows[0];
      const now = new Date();
      const lockActive =
        order.locked_by &&
        order.locked_until &&
        new Date(order.locked_until) > now;

      if (!lockActive || order.locked_by !== userId) {
        return { status: 403, body: { error: 'Caller does not hold an active lock on this order' } };
      }

      await conn.query(
        'UPDATE orders SET locked_by = NULL, locked_until = NULL WHERE id = ?',
        [orderId]
      );

      return { status: 200, body: { released: true } };
    });

    return res.status(outcome.status).json(outcome.body);
  } catch (err) {
    console.error('Release error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});


app.post('/orders/:id/scan', requireUser, async (req, res) => {
  const orderId = req.params.id;
  const userId = req.userId;
  const rawCode = typeof req.body?.code === 'string' ? req.body.code.trim().toLowerCase() : '';

  try {
    const outcome = await withTransaction(async (conn) => {
      const [orderRows] = await conn.query(
        'SELECT * FROM orders WHERE id = ? FOR UPDATE',
        [orderId]
      );
      if (orderRows.length === 0) {
        return { status: 404, body: { error: 'Order not found' } };
      }

      const order = orderRows[0];
      const now = new Date();
      const lockActive =
        order.locked_by &&
        order.locked_until &&
        new Date(order.locked_until) > now;

      if (!lockActive || order.locked_by !== userId) {
        return { status: 403, body: { error: 'Caller does not hold an unexpired lock on this order' } };
      }

      
      const newLockedUntil = new Date(now.getTime() + config.pickLockTtlSeconds * 1000);
      await conn.query(
        'UPDATE orders SET locked_until = ? WHERE id = ?',
        [newLockedUntil, orderId]
      );

      if (!rawCode) {
        return { status: 200, body: { result: 'NOT_FOUND' } };
      }

      
      const [productRows] = await conn.query(
        `SELECT * FROM product 
         WHERE LOWER(TRIM(sku)) = ? OR LOWER(TRIM(barcode)) = ? 
         LIMIT 1`,
        [rawCode, rawCode]
      );

      if (productRows.length === 0) {
        return { status: 200, body: { result: 'NOT_FOUND' } };
      }

      const product = productRows[0];

      
      const [lines] = await conn.query(
        'SELECT * FROM order_line WHERE order_id = ? FOR UPDATE',
        [orderId]
      );

      const matchingLines = lines.filter((l) => l.product_id === product.id);

      
      if (matchingLines.length === 0) {
        const [otherOrderRows] = await conn.query(
          `SELECT ol.order_id 
           FROM order_line ol
           JOIN orders o ON o.id = ol.order_id
           WHERE ol.product_id = ? 
             AND ol.picked_at IS NULL 
             AND o.status = 'OPEN'
             AND o.id != ?
           ORDER BY o.id ASC
           LIMIT 1`,
          [product.id, orderId]
        );

        const body = { result: 'WRONG_ITEM' };
        if (otherOrderRows.length > 0) {
          body.otherOrderId = otherOrderRows[0].order_id;
        }
        return { status: 200, body };
      }

      const unpickedLine = matchingLines.find((l) => l.picked_at === null);
      if (!unpickedLine) {
        return { status: 200, body: { result: 'ALREADY_PICKED' } };
      }

      await conn.query(
        'UPDATE order_line SET picked_at = ?, picked_by = ? WHERE id = ?',
        [now, userId, unpickedLine.id]
      );

      const remainingUnpicked = lines.filter(
        (l) => l.picked_at === null && l.id !== unpickedLine.id
      );

      let orderCompleted = false;
      if (remainingUnpicked.length === 0) {
        await conn.query(
          `UPDATE orders 
           SET status = 'PICKED', 
               picked_at = ?, 
               locked_by = NULL, 
               locked_until = NULL, 
               report_status = 'PENDING', 
               report_error = NULL 
           WHERE id = ?`,
          [now, orderId]
        );
        orderCompleted = true;
      }

      return {
        status: 200,
        body: { result: 'PICKED' },
        orderCompleted,
      };
    });

    if (outcome.orderCompleted) {
      await enqueueReportJob(orderId);
    }

    return res.status(outcome.status).json(outcome.body);
  } catch (err) {
    console.error('Scan error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/orders', async (_req, res) => {
  try {
    const [orders] = await pool.query(
      `SELECT id, external_id, payment_status, status, locked_by, locked_until,
              report_status, report_error
       FROM orders
       ORDER BY id ASC`
    );

    const now = new Date();
    return res.status(200).json(orders.map((order) => {
      const lockActive =
        order.locked_by &&
        order.locked_until &&
        new Date(order.locked_until) > now;

      return {
        id: order.id,
        externalId: order.external_id,
        paymentStatus: order.payment_status,
        status: order.status,
        lock: lockActive
          ? { heldBy: order.locked_by, lockedUntil: new Date(order.locked_until).toISOString() }
          : null,
        report: {
          status: order.report_status,
          error: order.report_error || null,
        },
      };
    }));
  } catch (err) {
    console.error('List orders error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/products', async (_req, res) => {
  try {
    const [products] = await pool.query(
      'SELECT id, sku, barcode, title, shelf FROM product ORDER BY id ASC'
    );
    return res.status(200).json(products);
  } catch (err) {
    console.error('List products error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/orders/:id', async (req, res) => {
  const orderId = req.params.id;

  try {
    const [orderRows] = await pool.query(
      'SELECT * FROM orders WHERE id = ?',
      [orderId]
    );
    if (orderRows.length === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }

    const order = orderRows[0];
    const [lineRows] = await pool.query(
      `SELECT ol.id, ol.product_id, p.sku, p.barcode, p.title, p.shelf, ol.picked_at, ol.picked_by
       FROM order_line ol
       JOIN product p ON p.id = ol.product_id
       WHERE ol.order_id = ?
       ORDER BY ol.id ASC`,
      [orderId]
    );

    const now = new Date();
    const lockActive =
      order.locked_by &&
      order.locked_until &&
      new Date(order.locked_until) > now;

    return res.status(200).json({
      id: order.id,
      externalId: order.external_id,
      paymentStatus: order.payment_status,
      status: order.status,
      lock: lockActive
        ? { heldBy: order.locked_by, lockedUntil: new Date(order.locked_until).toISOString() }
        : null,
      report: {
        status: order.report_status,
        error: order.report_error || null,
      },
      lines: lineRows,
    });
  } catch (err) {
    console.error('Get order error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/orders/:id/report/retry', async (req, res) => {
  const orderId = req.params.id;

  try {
    const [orderRows] = await pool.query(
      'SELECT id, status, report_status FROM orders WHERE id = ?',
      [orderId]
    );

    if (orderRows.length === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }

    const order = orderRows[0];
    if (order.status !== 'PICKED') {
      return res.status(400).json({ error: 'Order has not been picked' });
    }
    if (order.report_status === 'REPORTED') {
      return res.status(400).json({ error: 'Report was already accepted' });
    }

    await pool.query(
      `UPDATE orders
       SET report_status = 'PENDING', report_error = NULL
       WHERE id = ?`,
      [orderId]
    );

    await enqueueReportJob(orderId, `${Date.now()}-${Math.random().toString(36).slice(2)}`);

    return res.status(200).json({ retried: true });
  } catch (err) {
    console.error('Report retry error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export { app };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const PORT = config.port || process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
  });
}