const db = require('./db');

async function patch() {
  console.log('Patching schema for dual compatibility in TiDB...');
  
  async function colExists(table, col) {
    const [rows] = await db.query(
      'SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
      [table, col]
    );
    return rows.length > 0;
  }

  // reviews
  if (!(await colExists('reviews', 'rating'))) {
    await db.query('ALTER TABLE reviews ADD COLUMN rating INT NULL');
    await db.query('UPDATE reviews SET rating = rating_overall WHERE rating IS NULL');
    console.log('✅ Added reviews.rating');
  }

  // harvest_calendar
  if (!(await colExists('harvest_calendar', 'category'))) {
    await db.query("ALTER TABLE harvest_calendar ADD COLUMN category VARCHAR(50) DEFAULT 'Vegetables'");
    console.log('✅ Added harvest_calendar.category');
  }
  if (!(await colExists('harvest_calendar', 'acreage'))) {
    await db.query("ALTER TABLE harvest_calendar ADD COLUMN acreage DECIMAL(10,2) DEFAULT 1.0");
    console.log('✅ Added harvest_calendar.acreage');
  }
  if (!(await colExists('harvest_calendar', 'expected_quantity_kg'))) {
    await db.query("ALTER TABLE harvest_calendar ADD COLUMN expected_quantity_kg INT NULL");
    await db.query("UPDATE harvest_calendar SET expected_quantity_kg = estimated_quantity WHERE expected_quantity_kg IS NULL");
    console.log('✅ Added harvest_calendar.expected_quantity_kg');
  }
  if (!(await colExists('harvest_calendar', 'planting_date'))) {
    await db.query("ALTER TABLE harvest_calendar ADD COLUMN planting_date DATE NULL");
    console.log('✅ Added harvest_calendar.planting_date');
  }
  if (!(await colExists('harvest_calendar', 'notes'))) {
    await db.query("ALTER TABLE harvest_calendar ADD COLUMN notes TEXT NULL");
    console.log('✅ Added harvest_calendar.notes');
  }

  // wishlists
  if (!(await colExists('wishlists', 'buyer_id'))) {
    await db.query("ALTER TABLE wishlists ADD COLUMN buyer_id INT NULL");
    await db.query("UPDATE wishlists SET buyer_id = user_id WHERE buyer_id IS NULL");
    console.log('✅ Added wishlists.buyer_id');
  }

  // price_alerts
  if (!(await colExists('price_alerts', 'buyer_id'))) {
    await db.query("ALTER TABLE price_alerts ADD COLUMN buyer_id INT NULL");
    await db.query("UPDATE price_alerts SET buyer_id = user_id WHERE buyer_id IS NULL");
    console.log('✅ Added price_alerts.buyer_id');
  }
  if (!(await colExists('price_alerts', 'target_price'))) {
    await db.query("ALTER TABLE price_alerts ADD COLUMN target_price DECIMAL(10,2) NULL");
    await db.query("UPDATE price_alerts SET target_price = target_price_per_kg WHERE target_price IS NULL");
    console.log('✅ Added price_alerts.target_price');
  }

  console.log('Schema compatibility patch complete!');
  process.exit(0);
}

patch().catch(e => { console.error(e); process.exit(1); });
