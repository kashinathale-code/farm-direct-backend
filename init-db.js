const db = require('./db');

const createTables = async () => {
  try {
    console.log("Creating tables in TiDB...");

    // 1. Users Table
    await db.query(`
      CREATE TABLE IF NOT EXISTS users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        email VARCHAR(100) UNIQUE NOT NULL,
        password VARCHAR(255) NOT NULL,
        role ENUM('farmer', 'buyer') NOT NULL,
        location VARCHAR(255),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // 2. Crops Table
    await db.query(`
      CREATE TABLE IF NOT EXISTS crops (
        id INT AUTO_INCREMENT PRIMARY KEY,
        farmer_id INT,
        crop_name VARCHAR(100) NOT NULL,
        quantity_available INT NOT NULL,
        price_per_kg DECIMAL(10, 2) NOT NULL,
        description TEXT,
        category VARCHAR(50) DEFAULT 'Other',
        harvest_date DATE NULL,
        image MEDIUMTEXT NULL,
        bidding_enabled BOOLEAN DEFAULT FALSE,
        min_bidding_price DECIMAL(10, 2) NULL,
        traceability_code VARCHAR(64) UNIQUE NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (farmer_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);

    // 3. Orders Table
    await db.query(`
      CREATE TABLE IF NOT EXISTS orders (
        id INT AUTO_INCREMENT PRIMARY KEY,
        buyer_id INT,
        crop_id INT,
        quantity INT NOT NULL,
        total_price DECIMAL(10, 2) NOT NULL,
        status ENUM('pending', 'accepted', 'processing', 'shipped', 'delivered', 'cancelled', 'rejected') DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (buyer_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (crop_id) REFERENCES crops(id) ON DELETE CASCADE
      )
    `);

    // 4. Messages Table
    await db.query(`
      CREATE TABLE IF NOT EXISTS messages (
        id INT AUTO_INCREMENT PRIMARY KEY,
        sender_id INT,
        receiver_id INT,
        order_id INT,
        message_text TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (receiver_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
      )
    `);

    // 5. Crop Bids Table (Offers & Negotiations)
    await db.query(`
      CREATE TABLE IF NOT EXISTS crop_bids (
        id INT AUTO_INCREMENT PRIMARY KEY,
        crop_id INT NOT NULL,
        buyer_id INT NOT NULL,
        farmer_id INT NOT NULL,
        quantity INT NOT NULL,
        offered_price_per_kg DECIMAL(10,2) NOT NULL,
        current_by ENUM('buyer', 'farmer') NOT NULL DEFAULT 'buyer',
        status ENUM('pending', 'countered', 'accepted', 'rejected', 'cancelled', 'converted_to_order') DEFAULT 'pending',
        order_id INT NULL,
        expires_at TIMESTAMP NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (crop_id) REFERENCES crops(id) ON DELETE CASCADE,
        FOREIGN KEY (buyer_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (farmer_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE SET NULL
      )
    `);

    // 6. Negotiation History Table
    await db.query(`
      CREATE TABLE IF NOT EXISTS negotiation_history (
        id INT AUTO_INCREMENT PRIMARY KEY,
        bid_id INT NOT NULL,
        offered_by ENUM('buyer', 'farmer') NOT NULL,
        user_id INT NOT NULL,
        price_per_kg DECIMAL(10,2) NOT NULL,
        quantity INT NOT NULL,
        note TEXT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (bid_id) REFERENCES crop_bids(id) ON DELETE CASCADE
      )
    `);

    // 7. Group Buys Table
    await db.query(`
      CREATE TABLE IF NOT EXISTS group_buys (
        id INT AUTO_INCREMENT PRIMARY KEY,
        crop_id INT NOT NULL,
        farmer_id INT NOT NULL,
        title VARCHAR(200) NOT NULL,
        target_quantity INT NOT NULL,
        committed_quantity INT DEFAULT 0,
        discount_price_per_kg DECIMAL(10,2) NOT NULL,
        min_participants INT DEFAULT 2,
        start_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        end_date TIMESTAMP NOT NULL,
        status ENUM('active', 'completed', 'cancelled', 'expired') DEFAULT 'active',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (crop_id) REFERENCES crops(id) ON DELETE CASCADE,
        FOREIGN KEY (farmer_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);

    // 8. Group Buy Participants Table
    await db.query(`
      CREATE TABLE IF NOT EXISTS group_buy_participants (
        id INT AUTO_INCREMENT PRIMARY KEY,
        group_buy_id INT NOT NULL,
        buyer_id INT NOT NULL,
        quantity INT NOT NULL,
        total_price DECIMAL(10,2) NOT NULL,
        status ENUM('committed', 'converted_to_order', 'cancelled') DEFAULT 'committed',
        order_id INT NULL,
        joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (group_buy_id) REFERENCES group_buys(id) ON DELETE CASCADE,
        FOREIGN KEY (buyer_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE SET NULL
      )
    `);

    // 9. Order Status History Table
    await db.query(`
      CREATE TABLE IF NOT EXISTS order_status_history (
        id INT AUTO_INCREMENT PRIMARY KEY,
        order_id INT NOT NULL,
        status VARCHAR(50) NOT NULL,
        changed_by_user_id INT NULL,
        actor_role ENUM('farmer', 'buyer', 'system') NOT NULL DEFAULT 'system',
        note TEXT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
      )
    `);

    // 10. Persistent Notifications Table
    await db.query(`
      CREATE TABLE IF NOT EXISTS notifications (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        title VARCHAR(150) NOT NULL,
        message TEXT NOT NULL,
        link VARCHAR(255) NULL,
        type ENUM('order', 'bid', 'message', 'group_buy', 'crop') DEFAULT 'order',
        is_read BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);

    console.log("✅ All tables created successfully!");
    process.exit(0); // Closes the terminal process cleanly when done
  } catch (error) {
    console.error("❌ Error creating tables:", error);
    process.exit(1);
  }
};

// Execute the function
createTables();