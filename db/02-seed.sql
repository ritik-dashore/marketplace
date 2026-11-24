INSERT IGNORE INTO product (id, sku, barcode, title, shelf) VALUES
(1, 'MOB101', '111222', 'Mobile', 'A1'),
(2, 'CHG101', '333444', 'Charger', 'B2'),
(3, 'HPH101', '555666', 'Headphone', 'C3');

INSERT IGNORE INTO orders (id, external_id, payment_status, status, report_status) VALUES
(1, 'EXT1001', 'PAID', 'OPEN', 'NONE'),
-- (2, 'EXT1002', 'UNPAID', 'OPEN', 'NONE');
(2, 'EXT1002', 'PAID', 'OPEN', 'NONE');

INSERT IGNORE INTO order_line (id, order_id, product_id, picked_at, picked_by) VALUES
(1, 1, 1, NULL, NULL),
(2, 1, 2, NULL, NULL),
(3, 1, 3, NULL, NULL);
