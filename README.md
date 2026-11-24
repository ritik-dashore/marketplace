# Warehouse Picking Service

A warehouse order-picking API backed by MySQL. Pickers claim an order, scan products by SKU or barcode, and the service queues a marketplace report after the order is fully picked.

## Requirements

- Docker Desktop with Docker Compose
- Node.js 20 or newer and npm (needed to run the test suite from the host)
- The marketplace mock service on `http://localhost:4000` when testing report delivery; it is not included in this Compose project

## Run with Docker Compose

From the project root:

```powershell
docker compose up --build
```

Compose starts MySQL, Redis, the API, and the report worker. The API is available at `http://localhost:3000` by default. MySQL is exposed on host port `3307`; Redis is exposed on `6379`.

To start the services in the background:

```powershell
docker compose up --build -d
```

View service status and logs:

```powershell
docker compose ps
docker compose logs -f api worker
docker compose logs -f mysql
```

Stop the services without deleting the database volume:

```powershell
docker compose down
```

The `mysqldata` Docker volume persists database contents across restarts. `docker compose down -v` deletes that volume and its data; use it only when you intentionally want a fresh database.

## Database and seed data

MySQL creates the `market-place` database and runs SQL files mounted from `db/` only when its data directory is initialized for the first time. The seed is starting/sample data, not a live synchronization mechanism. Editing `db/02-seed.sql` does not update an already initialized volume; use SQL against the running database for changes to existing rows.

The current seed has three sample products. Order 1 is paid and has three lines. Order 2 is paid but currently has no order lines, so it can be claimed but cannot demonstrate picking until lines are added. Check live data through `GET /orders`, `GET /orders/:id`, and `GET /products`.

For example, to make order 2 ready to pick using the three seeded products, run this from PowerShell in the project root:

```powershell
docker compose exec -T mysql mysql -u market-place -pmarket-place_password market-place -e "UPDATE orders SET payment_status='PAID', status='OPEN', locked_by=NULL, locked_until=NULL, picked_at=NULL, report_status='NONE', report_error=NULL WHERE id=2; UPDATE order_line SET picked_at=NULL, picked_by=NULL WHERE order_id=2; INSERT INTO order_line (order_id, product_id) SELECT 2, p.id FROM product p WHERE p.id IN (1,2,3) AND NOT EXISTS (SELECT 1 FROM order_line ol WHERE ol.order_id=2 AND ol.product_id=p.id);"
```

The insert is safe to repeat for the same product/order pairs. Use the actual IDs returned by the API or MySQL if your database has different rows.

## Configuration

Compose supports these environment variables:

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `3000` | API host/container port |
| `PICK_LOCK_TTL_SECONDS` | `900` | Claim duration and lock renewal period |
| `MARKETPLACE_URL` | `http://host.docker.internal:4000` | Marketplace base URL used by the worker |

Set overrides in PowerShell before starting Compose, for example:

```powershell
$env:PORT = '3100'
$env:PICK_LOCK_TTL_SECONDS = '30'
$env:MARKETPLACE_URL = 'http://host.docker.internal:4000'
docker compose up --build
```

The worker includes the `host.docker.internal:host-gateway` mapping required by Docker on Linux. Start your marketplace mock separately; Compose does not start it.

## API

All order IDs are dynamic URL parameters. The API reads and updates the current MySQL rows; it does not have separate code paths for order 1 or order 2. Picking requests require the `X-User-Id` header.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/orders` | List current orders |
| `GET` | `/orders/:id` | Get order, lines, lock, and report status |
| `POST` | `/orders/:id/claim` | Claim or renew a pick lock; requires `X-User-Id` |
| `POST` | `/orders/:id/release` | Release the caller's active lock; requires `X-User-Id` |
| `POST` | `/orders/:id/scan` | Scan `{ "code": "SKU-or-barcode" }`; requires `X-User-Id` |
| `POST` | `/orders/:id/report/retry` | Retry a marketplace report after a pick is complete |
| `GET` | `/products` | List current products |

Scan result values are `PICKED`, `ALREADY_PICKED`, `WRONG_ITEM`, and `NOT_FOUND`. Scanning requires an active lock held by the caller. A wrong-item response includes `otherOrderId` when the product has an unpicked line on another open order.

Example PowerShell requests:

```powershell
$headers = @{ 'X-User-Id' = 'picker-1' }
Invoke-RestMethod -Uri 'http://localhost:3000/orders' -Method Get
Invoke-RestMethod -Uri 'http://localhost:3000/orders/1/claim' -Method Post -Headers $headers
Invoke-RestMethod -Uri 'http://localhost:3000/orders/1/scan' -Method Post -Headers $headers -ContentType 'application/json' -Body '{"code":"MOB101"}'
Invoke-RestMethod -Uri 'http://localhost:3000/orders/1' -Method Get
```

Claim the order before scanning. Scan each unpicked line's SKU or barcode; after the last line, the API releases the lock and the worker sends the marketplace report asynchronously.

## Tests

Install host dependencies and run the test suite:

```powershell
npm ci
npm test
```

The API integration test connects to MySQL at `127.0.0.1:3307` and Redis at `127.0.0.1:6379`, so start the Compose services first. It creates temporary test records and removes them afterward. Configuration tests run with Node's built-in test runner.

## Project layout

- `src/api.js`: HTTP routes and picking rules
- `src/db.js`: MySQL pool and transaction helper
- `src/queue.js`: Redis/BullMQ report queue
- `src/worker.js`: asynchronous marketplace reporting and pending-job recovery
- `db/`: MySQL schema, seed, and initialization SQL
- `test/`: configuration and API integration tests
- `warehouse-picking.postman_collection.json`: Postman requests

## Troubleshooting

- **API cannot connect to MySQL or Redis:** use `docker compose ps` and check `docker compose logs mysql redis api`. The API depends on healthy MySQL and Redis services.
- **The API shows old seed data:** the named MySQL volume is persistent. Seed scripts run only on first initialization; update rows with SQL or deliberately recreate an empty test database.
- **The marketplace report fails:** ensure the mock is listening on host port `4000`, then inspect `docker compose logs -f worker` and the order's `report` field from `GET /orders/:id`.
- **Host port is already in use:** set `PORT` to a free port before starting Compose. MySQL and Redis host ports are currently fixed at `3307` and `6379` in `docker-compose.yml`.
