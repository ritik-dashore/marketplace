USE `market-place`;

CREATE TABLE IF NOT EXISTS product (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  sku VARCHAR(100) NOT NULL,
  barcode VARCHAR(100) NOT NULL,
  title VARCHAR(255) NOT NULL,
  shelf VARCHAR(100) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_product_sku (sku),
  UNIQUE KEY uq_product_barcode (barcode)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS orders (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  external_id VARCHAR(100) NOT NULL,
  payment_status VARCHAR(20) NOT NULL,
  status VARCHAR(20) NOT NULL,
  locked_by VARCHAR(100) NULL,
  locked_until DATETIME NULL,
  picked_at DATETIME NULL,
  report_status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
  report_error TEXT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_orders_external_id (external_id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS order_line (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  order_id INT UNSIGNED NOT NULL,
  product_id INT UNSIGNED NOT NULL,
  picked_at DATETIME NULL,
  picked_by VARCHAR(100) NULL,
  PRIMARY KEY (id),
  KEY idx_order_line_order (order_id),
  KEY idx_order_line_product (product_id),
  CONSTRAINT fk_order_line_order FOREIGN KEY (order_id) REFERENCES orders(id),
  CONSTRAINT fk_order_line_product FOREIGN KEY (product_id) REFERENCES product(id)
) ENGINE=InnoDB;

-- 01-schema.sql creates the tables and 02-seed.sql loads the required seed data.
-- This file is intentionally left as a compatibility placeholder.
