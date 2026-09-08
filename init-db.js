const db = require('./db');

const createTables = async () => {
    try {
        // 1. Users Table
        await db.query(`
      CREATE TABLE IF NOT EXISTS users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        email VARCHAR(100) UNIQUE NOT NULL,
        password VARCHAR(255) NOT NULL,
        role ENUM('farmer', 'buyer') NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

        // 2. Crops Table
        await db.query(`
      CREATE TABLE IF NOT EXISTS crops (
        id INT AUTO_INCREMENT PRIMARY KEY,
        farmer_id INT,
        name VARCHAR(100) NOT NULL,
        quantity INT NOT NULL,
        price DECIMAL(10, 2) NOT NULL,
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
        content TEXT NOT NULL,
        sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (receiver_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);

        console.log("✅ All tables created successfully!");
        process.exit(0);
    } catch (error) {
        console.error("❌ Error creating tables:", error);
        process.exit(1);
    }
};

createTables();