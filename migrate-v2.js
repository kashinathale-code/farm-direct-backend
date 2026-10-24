// Database migration script v2: Additive expansion for Bidding, Traceability, Group Buying, Notifications, and Order Timeline
const db = require('./db');
const crypto = require('crypto');

async function migrateV2() {
  try {
    console.log('🌱 Starting Farm Direct Migration v2...');

    // Helper: Check if a table exists in the current database
    async function tableExists(tableName) {
      const [rows] = await db.query(
        `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
        [tableName]
      );
      return rows.length > 0;
    }

    // Helper: Check if a column exists in a specific table
    async function columnExists(tableName, columnName) {
      const [rows] = await db.query(
        `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
        [tableName, columnName]
      );
      return rows.length > 0;
    }

    // 1. Extend crops table with bidding and traceability columns
    if (await tableExists('crops')) {
      if (!(await columnExists('crops', 'bidding_enabled'))) {
        await db.query(`ALTER TABLE crops ADD COLUMN bidding_enabled BOOLEAN DEFAULT FALSE`);
        console.log('✅ Added crops.bidding_enabled');
      }
      if (!(await columnExists('crops', 'min_bidding_price'))) {
        await db.query(`ALTER TABLE crops ADD COLUMN min_bidding_price DECIMAL(10,2) NULL`);
        console.log('✅ Added crops.min_bidding_price');
      }
      if (!(await columnExists('crops', 'traceability_code'))) {
        await db.query(`ALTER TABLE crops ADD COLUMN traceability_code VARCHAR(64) NULL`);
        console.log('✅ Added crops.traceability_code');
      }

      // Backfill traceability_code for any existing crops that lack one
      const [cropsWithoutCode] = await db.query(`SELECT id FROM crops WHERE traceability_code IS NULL OR traceability_code = ''`);
      for (const crop of cropsWithoutCode) {
        const code = 'FD-' + crypto.randomBytes(4).toString('hex').toUpperCase();
        await db.query(`UPDATE crops SET traceability_code = ? WHERE id = ?`, [code, crop.id]);
      }
      if (cropsWithoutCode.length > 0) {
        console.log(`✅ Backfilled traceability_code for ${cropsWithoutCode.length} crops`);
      }

      // Check and add unique index on traceability_code
      const [indexes] = await db.query(`SHOW INDEX FROM crops WHERE Key_name = 'idx_crops_traceability'`);
      if (indexes.length === 0) {
        await db.query(`ALTER TABLE crops ADD UNIQUE INDEX idx_crops_traceability (traceability_code)`);
        console.log('✅ Added unique index idx_crops_traceability');
      }
    }

    // 1b. Update orders.status ENUM to include full lifecycle statuses
    if (await tableExists('orders')) {
      await db.query(`
        ALTER TABLE orders 
        MODIFY COLUMN status ENUM('pending', 'accepted', 'processing', 'shipped', 'delivered', 'cancelled', 'rejected') DEFAULT 'pending'
      `);
      console.log('✅ Updated orders.status ENUM for full lifecycle support');
    }

    // 2. Create crop_bids (Offers & Negotiations)
    if (!(await tableExists('crop_bids'))) {
      await db.query(`
        CREATE TABLE crop_bids (
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
          FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE SET NULL,
          INDEX idx_bids_crop (crop_id),
          INDEX idx_bids_buyer (buyer_id),
          INDEX idx_bids_farmer (farmer_id)
        )
      `);
      console.log('✅ Created table: crop_bids');
    } else {
      console.log('ℹ️ Table crop_bids already exists (skipped)');
    }

    // 3. Create negotiation_history
    if (!(await tableExists('negotiation_history'))) {
      await db.query(`
        CREATE TABLE negotiation_history (
          id INT AUTO_INCREMENT PRIMARY KEY,
          bid_id INT NOT NULL,
          offered_by ENUM('buyer', 'farmer') NOT NULL,
          user_id INT NOT NULL,
          price_per_kg DECIMAL(10,2) NOT NULL,
          quantity INT NOT NULL,
          note TEXT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (bid_id) REFERENCES crop_bids(id) ON DELETE CASCADE,
          INDEX idx_history_bid (bid_id)
        )
      `);
      console.log('✅ Created table: negotiation_history');
    } else {
      console.log('ℹ️ Table negotiation_history already exists (skipped)');
    }

    // 4. Create group_buys (Community Group Buying campaigns)
    if (!(await tableExists('group_buys'))) {
      await db.query(`
        CREATE TABLE group_buys (
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
          FOREIGN KEY (farmer_id) REFERENCES users(id) ON DELETE CASCADE,
          INDEX idx_gb_crop (crop_id),
          INDEX idx_gb_farmer (farmer_id)
        )
      `);
      console.log('✅ Created table: group_buys');
    } else {
      console.log('ℹ️ Table group_buys already exists (skipped)');
    }

    // 5. Create group_buy_participants
    if (!(await tableExists('group_buy_participants'))) {
      await db.query(`
        CREATE TABLE group_buy_participants (
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
          FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE SET NULL,
          UNIQUE KEY unique_buyer_gb (group_buy_id, buyer_id),
          INDEX idx_gbp_user (buyer_id)
        )
      `);
      console.log('✅ Created table: group_buy_participants');
    } else {
      console.log('ℹ️ Table group_buy_participants already exists (skipped)');
    }

    // 6. Create order_status_history
    if (!(await tableExists('order_status_history'))) {
      await db.query(`
        CREATE TABLE order_status_history (
          id INT AUTO_INCREMENT PRIMARY KEY,
          order_id INT NOT NULL,
          status VARCHAR(50) NOT NULL,
          changed_by_user_id INT NULL,
          actor_role ENUM('farmer', 'buyer', 'system') NOT NULL DEFAULT 'system',
          note TEXT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
          INDEX idx_osh_order (order_id)
        )
      `);
      console.log('✅ Created table: order_status_history');
    } else {
      console.log('ℹ️ Table order_status_history already exists (skipped)');
    }

    // 7. Create notifications
    if (!(await tableExists('notifications'))) {
      await db.query(`
        CREATE TABLE notifications (
          id INT AUTO_INCREMENT PRIMARY KEY,
          user_id INT NOT NULL,
          title VARCHAR(150) NOT NULL,
          message TEXT NOT NULL,
          link VARCHAR(255) NULL,
          type ENUM('order', 'bid', 'message', 'group_buy', 'crop') DEFAULT 'order',
          is_read BOOLEAN DEFAULT FALSE,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
          INDEX idx_notif_user_read (user_id, is_read)
        )
      `);
      console.log('✅ Created table: notifications');
    } else {
      console.log('ℹ️ Table notifications already exists (skipped)');
    }

    console.log('🎉 Migration v2 completed successfully! All tables and fields verified.');
    process.exit(0);
  } catch (error) {
    console.error('❌ Migration v2 failed:', error.message);
    process.exit(1);
  }
}

migrateV2();
