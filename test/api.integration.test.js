import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';

process.env.DB_HOST ||= '127.0.0.1';
process.env.DB_PORT ||= '3307';
process.env.REDIS_URL ||= 'redis://127.0.0.1:6379';

const [{ app }, { pool }, { connection, reportQueue }] = await Promise.all([
  import('../src/api.js'),
  import('../src/db.js'),
  import('../src/queue.js'),
]);

async function requestJson(url, options) {
  const response = await fetch(url, options);
  return { response, body: await response.json() };
}

test('API reads dynamic MySQL data and enforces picking rules', async (t) => {
  let server;
  let targetOrderId;
  let otherOrderId;
  const productIds = [];

  try {
    await pool.query('SELECT 1');
    await connection.ping();
  } catch {
    t.skip('MySQL on port 3307 and Redis on port 6379 are required for API integration tests');
    await Promise.allSettled([pool.end(), reportQueue.close(), connection.quit()]);
    return;
  }

  try {
    const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const productFixtures = [
      [`IT-PICK-${runId}`, `IT-BARCODE-PICK-${runId}`, 'Integration pick item'],
      [`IT-SECOND-${runId}`, `IT-BARCODE-SECOND-${runId}`, 'Integration second item'],
      [`IT-OTHER-${runId}`, `IT-BARCODE-OTHER-${runId}`, 'Integration other-order item'],
    ];

    for (const [sku, barcode, title] of productFixtures) {
      const [result] = await pool.query(
        'INSERT INTO product (sku, barcode, title, shelf) VALUES (?, ?, ?, ?)',
        [sku, barcode, title, 'TEST']
      );
      productIds.push(result.insertId);
    }

    const [targetOrder] = await pool.query(
      `INSERT INTO orders (external_id, payment_status, status, report_status)
       VALUES (?, 'PAID', 'OPEN', 'NONE')`,
      [`IT-TARGET-${runId}`]
    );
    targetOrderId = targetOrder.insertId;

    const [otherOrder] = await pool.query(
      `INSERT INTO orders (external_id, payment_status, status, report_status)
       VALUES (?, 'UNPAID', 'OPEN', 'NONE')`,
      [`IT-OTHER-${runId}`]
    );
    otherOrderId = otherOrder.insertId;

    await pool.query(
      'INSERT INTO order_line (order_id, product_id) VALUES (?, ?), (?, ?)',
      [targetOrderId, productIds[0], targetOrderId, productIds[1]]
    );
    await pool.query(
      'INSERT INTO order_line (order_id, product_id) VALUES (?, ?)',
      [otherOrderId, productIds[2]]
    );

    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const baseUrl = `http://127.0.0.1:${server.address().port}`;

    const { response: ordersResponse, body: orders } = await requestJson(`${baseUrl}/orders`);
    assert.equal(ordersResponse.status, 200);
    assert.ok(orders.some((order) => order.id === targetOrderId));

    const { response: productsResponse, body: products } = await requestJson(`${baseUrl}/products`);
    assert.equal(productsResponse.status, 200);
    assert.ok(products.some((product) => product.id === productIds[0]));

    const { response: unpaidResponse } = await requestJson(`${baseUrl}/orders/${otherOrderId}/claim`, {
      method: 'POST',
      headers: { 'X-User-Id': 'integration-picker' },
    });
    assert.equal(unpaidResponse.status, 400);

    const pickerHeaders = { 'X-User-Id': 'integration-picker' };
    const { response: claimResponse } = await requestJson(`${baseUrl}/orders/${targetOrderId}/claim`, {
      method: 'POST',
      headers: pickerHeaders,
    });
    assert.equal(claimResponse.status, 200);

    const { response: competingResponse, body: competingBody } = await requestJson(
      `${baseUrl}/orders/${targetOrderId}/claim`,
      { method: 'POST', headers: { 'X-User-Id': 'other-picker' } }
    );
    assert.equal(competingResponse.status, 409);
    assert.equal(competingBody.heldBy, 'integration-picker');

    const { body: unknownScan } = await requestJson(`${baseUrl}/orders/${targetOrderId}/scan`, {
      method: 'POST',
      headers: { ...pickerHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'not-a-real-item' }),
    });
    assert.equal(unknownScan.result, 'NOT_FOUND');

    const otherSku = productFixtures[2][0];
    const { body: wrongScan } = await requestJson(`${baseUrl}/orders/${targetOrderId}/scan`, {
      method: 'POST',
      headers: { ...pickerHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: ` ${otherSku.toLowerCase()} ` }),
    });
    assert.equal(wrongScan.result, 'WRONG_ITEM');
    assert.equal(wrongScan.otherOrderId, otherOrderId);

    const pickSku = productFixtures[0][0];
    const { body: pickedScan } = await requestJson(`${baseUrl}/orders/${targetOrderId}/scan`, {
      method: 'POST',
      headers: { ...pickerHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: ` ${pickSku.toLowerCase()} ` }),
    });
    assert.equal(pickedScan.result, 'PICKED');

    const { body: duplicateScan } = await requestJson(`${baseUrl}/orders/${targetOrderId}/scan`, {
      method: 'POST',
      headers: { ...pickerHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: pickSku }),
    });
    assert.equal(duplicateScan.result, 'ALREADY_PICKED');

    const { body: detail } = await requestJson(`${baseUrl}/orders/${targetOrderId}`);
    assert.equal(detail.lines.length, 2);
    assert.ok(detail.lines.find((line) => line.product_id === productIds[0]).picked_at);

    const { response: releaseResponse, body: releaseBody } = await requestJson(
      `${baseUrl}/orders/${targetOrderId}/release`,
      { method: 'POST', headers: pickerHeaders }
    );
    assert.equal(releaseResponse.status, 200);
    assert.equal(releaseBody.released, true);
  } finally {
    if (server) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }

    const orderIds = [targetOrderId, otherOrderId].filter(Number.isInteger);
    if (orderIds.length > 0) {
      const placeholders = orderIds.map(() => '?').join(', ');
      await pool.query(`DELETE FROM orders WHERE id IN (${placeholders})`, orderIds);
    }
    if (productIds.length > 0) {
      const placeholders = productIds.map(() => '?').join(', ');
      await pool.query(`DELETE FROM product WHERE id IN (${placeholders})`, productIds);
    }

    await Promise.allSettled([pool.end(), reportQueue.close(), connection.quit()]);
  }
});
