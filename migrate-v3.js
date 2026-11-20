// Database migration script v3: Location, Market Prices, Wishlist, Price Alerts, Reviews, Bulk Pricing, Harvest Calendar, Profit Calculator, Batch Traceability, and Analytics
const db = require('./db');

async function migrateV3() {
  try {
    console.log('🌱 Starting Farm Direct Migration v3...');

    async function tableExists(tableName) {
      const [rows] = await db.query(
        `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
        [tableName]
      );
      return rows.length > 0;
    }

    async function columnExists(tableName, columnName) {
      const [rows] = await db.query(
        `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
        [tableName, columnName]
      );
      return rows.length > 0;
    }

    // 1. Extend users table for Location, Verification, and Profile
    if (await tableExists('users')) {
      const userCols = [
        { name: 'state', def: 'VARCHAR(100) NULL' },
        { name: 'district', def: 'VARCHAR(100) NULL' },
        { name: 'village', def: 'VARCHAR(150) NULL' },
        { name: 'pincode', def: 'VARCHAR(10) NULL' },
        { name: 'latitude', def: 'DECIMAL(10,8) NULL' },
        { name: 'longitude', def: 'DECIMAL(11,8) NULL' },
        { name: 'is_verified', def: 'BOOLEAN DEFAULT FALSE' },
        { name: 'verification_status', def: "ENUM('unverified', 'pending', 'verified') DEFAULT 'unverified'" },
        { name: 'experience_years', def: 'INT DEFAULT 0' },
        { name: 'farming_bio', def: 'TEXT NULL' },
        { name: 'profile_image', def: 'MEDIUMTEXT NULL' }
      ];

      for (const col of userCols) {
        if (!(await columnExists('users', col.name))) {
          await db.query(`ALTER TABLE users ADD COLUMN ${col.name} ${col.def}`);
          console.log(`✅ Added users.${col.name}`);
        }
      }
    }

    // 2. Extend crops table for Bulk Pricing and Batch Traceability
    if (await tableExists('crops')) {
      if (!(await columnExists('crops', 'batch_id'))) {
        await db.query(`ALTER TABLE crops ADD COLUMN batch_id VARCHAR(64) NULL`);
        console.log('✅ Added crops.batch_id');
      }
      if (!(await columnExists('crops', 'bulk_pricing'))) {
        await db.query(`ALTER TABLE crops ADD COLUMN bulk_pricing JSON NULL`);
        console.log('✅ Added crops.bulk_pricing');
      }
    }

    // 3. Extend orders table for Bulk Tier Pricing and Unit Price
    if (await tableExists('orders')) {
      if (!(await columnExists('orders', 'unit_price'))) {
        await db.query(`ALTER TABLE orders ADD COLUMN unit_price DECIMAL(10,2) NULL`);
        console.log('✅ Added orders.unit_price');
      }
      if (!(await columnExists('orders', 'applied_tier_discount'))) {
        await db.query(`ALTER TABLE orders ADD COLUMN applied_tier_discount DECIMAL(10,2) DEFAULT 0`);
        console.log('✅ Added orders.applied_tier_discount');
      }
    }

    // 4. Create market_price_cache table
    if (!(await tableExists('market_price_cache'))) {
      await db.query(`
        CREATE TABLE market_price_cache (
          id INT AUTO_INCREMENT PRIMARY KEY,
          state VARCHAR(100) NOT NULL,
          district VARCHAR(100) NOT NULL,
          market_name VARCHAR(150) NOT NULL,
          commodity VARCHAR(100) NOT NULL,
          variety VARCHAR(100) DEFAULT 'Common',
          grade VARCHAR(50) DEFAULT 'FAQ',
          min_price DECIMAL(10,2) NOT NULL,
          max_price DECIMAL(10,2) NOT NULL,
          modal_price DECIMAL(10,2) NOT NULL,
          price_unit VARCHAR(50) DEFAULT '₹/Quintal',
          arrival_qty DECIMAL(10,2) NULL,
          arrival_date DATE NOT NULL,
          source VARCHAR(150) DEFAULT 'Agmarknet / data.gov.in',
          fetched_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          INDEX idx_market_lookup (commodity, district, state),
          INDEX idx_date (arrival_date)
        )
      `);
      console.log('✅ Created table: market_price_cache');
    }

    // 5. Create wishlists table
    if (!(await tableExists('wishlists'))) {
      await db.query(`
        CREATE TABLE wishlists (
          id INT AUTO_INCREMENT PRIMARY KEY,
          user_id INT NOT NULL,
          crop_id INT NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
          FOREIGN KEY (crop_id) REFERENCES crops(id) ON DELETE CASCADE,
          UNIQUE KEY unique_user_crop (user_id, crop_id)
        )
      `);
      console.log('✅ Created table: wishlists');
    }

    // 6. Create price_alerts table
    if (!(await tableExists('price_alerts'))) {
      await db.query(`
        CREATE TABLE price_alerts (
          id INT AUTO_INCREMENT PRIMARY KEY,
          user_id INT NOT NULL,
          crop_name VARCHAR(100) NOT NULL,
          target_price_per_kg DECIMAL(10,2) NOT NULL,
          district VARCHAR(100) NULL,
          is_active BOOLEAN DEFAULT TRUE,
          triggered_at TIMESTAMP NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
          INDEX idx_alert_user (user_id)
        )
      `);
      console.log('✅ Created table: price_alerts');
    }

    // 7. Create reviews table
    if (!(await tableExists('reviews'))) {
      await db.query(`
        CREATE TABLE reviews (
          id INT AUTO_INCREMENT PRIMARY KEY,
          order_id INT UNIQUE NOT NULL,
          farmer_id INT NOT NULL,
          buyer_id INT NOT NULL,
          crop_id INT NOT NULL,
          rating_overall INT NOT NULL,
          rating_quality INT DEFAULT 5,
          rating_communication INT DEFAULT 5,
          rating_delivery INT DEFAULT 5,
          review_text TEXT NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
          FOREIGN KEY (farmer_id) REFERENCES users(id) ON DELETE CASCADE,
          FOREIGN KEY (buyer_id) REFERENCES users(id) ON DELETE CASCADE,
          FOREIGN KEY (crop_id) REFERENCES crops(id) ON DELETE CASCADE,
          INDEX idx_farmer_reviews (farmer_id)
        )
      `);
      console.log('✅ Created table: reviews');
    }

    // 8. Create harvest_calendar table
    if (!(await tableExists('harvest_calendar'))) {
      await db.query(`
        CREATE TABLE harvest_calendar (
          id INT AUTO_INCREMENT PRIMARY KEY,
          farmer_id INT NOT NULL,
          crop_name VARCHAR(100) NOT NULL,
          variety VARCHAR(100) NULL,
          expected_harvest_date DATE NOT NULL,
          estimated_quantity INT NOT NULL,
          availability_start_date DATE NULL,
          availability_end_date DATE NULL,
          status ENUM('planned', 'growing', 'ready_for_harvest', 'harvested', 'cancelled') DEFAULT 'planned',
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (farmer_id) REFERENCES users(id) ON DELETE CASCADE,
          INDEX idx_farmer_harvest (farmer_id)
        )
      `);
      console.log('✅ Created table: harvest_calendar');
    }

    // 9. Create profit_calculations table
    if (!(await tableExists('profit_calculations'))) {
      await db.query(`
        CREATE TABLE profit_calculations (
          id INT AUTO_INCREMENT PRIMARY KEY,
          farmer_id INT NOT NULL,
          crop_name VARCHAR(100) NOT NULL,
          quantity INT NOT NULL,
          quantity_unit VARCHAR(20) DEFAULT 'kg',
          selling_price DECIMAL(10,2) NOT NULL,
          seed_cost DECIMAL(10,2) DEFAULT 0,
          fertilizer_cost DECIMAL(10,2) DEFAULT 0,
          labour_cost DECIMAL(10,2) DEFAULT 0,
          irrigation_cost DECIMAL(10,2) DEFAULT 0,
          transport_cost DECIMAL(10,2) DEFAULT 0,
          other_costs DECIMAL(10,2) DEFAULT 0,
          gross_revenue DECIMAL(10,2) NOT NULL,
          total_expenses DECIMAL(10,2) NOT NULL,
          net_profit DECIMAL(10,2) NOT NULL,
          profit_margin DECIMAL(5,2) NOT NULL,
          mandi_selling_price DECIMAL(10,2) NULL,
          potential_savings DECIMAL(10,2) NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (farmer_id) REFERENCES users(id) ON DELETE CASCADE,
          INDEX idx_farmer_profit (farmer_id)
        )
      `);
      console.log('✅ Created table: profit_calculations');
    }

    // 10. Create traceability_events table
    if (!(await tableExists('traceability_events'))) {
      await db.query(`
        CREATE TABLE traceability_events (
          id INT AUTO_INCREMENT PRIMARY KEY,
          crop_id INT NOT NULL,
          event_type VARCHAR(50) NOT NULL,
          title VARCHAR(150) NOT NULL,
          description TEXT NOT NULL,
          location VARCHAR(200) NULL,
          recorded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (crop_id) REFERENCES crops(id) ON DELETE CASCADE,
          INDEX idx_crop_events (crop_id)
        )
      `);
      console.log('✅ Created table: traceability_events');
    }

    // 11. Create marketplace_analytics_events table
    if (!(await tableExists('marketplace_analytics_events'))) {
      await db.query(`
        CREATE TABLE marketplace_analytics_events (
          id INT AUTO_INCREMENT PRIMARY KEY,
          event_type ENUM('search', 'view', 'wishlist', 'order') NOT NULL,
          crop_name VARCHAR(100) NULL,
          category VARCHAR(50) NULL,
          user_id INT NULL,
          district VARCHAR(100) NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          INDEX idx_event_type (event_type),
          INDEX idx_event_crop (crop_name)
        )
      `);
      console.log('✅ Created table: marketplace_analytics_events');
    }

    console.log('🎉 Migration v3 completed successfully! All tables and fields verified.');
    process.exit(0);
  } catch (error) {
    console.error('❌ Migration v3 failed:', error);
    process.exit(1);
  }
}

migrateV3();
