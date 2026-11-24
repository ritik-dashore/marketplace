# Notes

## Running

```powershell
docker compose up --build
npm test
```

The services use MySQL rather than Postgres. The API is at `http://localhost:${PORT:-3000}`, Redis at `6379`, and MySQL at `3307` on the host.

The required seed is loaded by MySQL's first-start initialization scripts in `db/`.
Seed rows are sample data only; the API reads current orders and products from MySQL by ID and does not special-case order 1 or 2.
`npm test` runs the API integration test when MySQL and Redis are available on the host ports above.

## Decisions

- MySQL is used for all relational storage and transactions.
- Redis and BullMQ provide the marketplace report queue.
- BullMQ uses a stable per-order job ID and the marketplace also receives an idempotency key.
- A `409` from the marketplace is treated as already accepted.
- Final `400` and exhausted retry states are stored on the order as `FAILED`.
- The worker polls picked, pending orders and re-enqueues their stable job IDs after restarts or missed enqueue attempts.
- `PICK_LOCK_TTL_SECONDS` controls lock renewal and expiry.

## Known limitations

- Marketplace request outcomes still need end-to-end testing against the external mock service.
- API database failures could benefit from stronger reconnect handling.
- The implementation uses polling-style database reads without a dedicated notification mechanism.
- MySQL row locking protects the documented lock and scan operations, but distributed Redis locks are not additionally used.

## Next steps

- Add marketplace mock integration tests for `200`, `409`, `400`, slow, and `5xx` responses.
- Add BullMQ job event and worker restart recovery tests.
- Add database indexes for barcode/SKU and order-line lookups.
