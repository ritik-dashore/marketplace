CREATE TABLE IF NOT EXISTS product (
    id INT AUTO_INCREMENT PRIMARY KEY,
    sku VARCHAR(100) NOT NULL UNIQUE,
    barcode VARCHAR(100) NOT NULL,
    title VARCHAR(255) NOT NULL,
    shelf VARCHAR(50) NOT NULL
);

CREATE TABLE IF NOT EXISTS orders (
    id INT AUTO_INCREMENT PRIMARY KEY,
    external_id VARCHAR(100) NOT NULL UNIQUE,
    payment_status ENUM('PAID', 'UNPAID') NOT NULL,
    status ENUM('OPEN', 'PICKED') NOT NULL DEFAULT 'OPEN',
    locked_by VARCHAR(100) NULL,
    locked_until DATETIME NULL,
    picked_at DATETIME NULL,
    report_status ENUM('NONE', 'PENDING', 'REPORTED', 'FAILED') NOT NULL DEFAULT 'NONE',
    report_error TEXT NULL
);

CREATE TABLE IF NOT EXISTS order_line (
    id INT AUTO_INCREMENT PRIMARY KEY,
    order_id INT NOT NULL,
    product_id INT NOT NULL,
    picked_at DATETIME NULL,
    picked_by VARCHAR(100) NULL,
    FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
    FOREIGN KEY (product_id) REFERENCES product(id)
);
