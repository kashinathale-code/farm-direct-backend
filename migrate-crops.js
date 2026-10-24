// Migration script to safely add category, harvest_date, and image columns to crops table
const db = require('./db');

async function migrate() {
  try {
    console.log('Starting crops table migration...');

    // Fetch existing column names for the crops table in current database
    const [columns] = await db.query(
      `SELECT COLUMN_NAME 
       FROM INFORMATION_SCHEMA.COLUMNS 
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'crops'`
    );

    const existingColumns = columns.map(c => c.COLUMN_NAME.toLowerCase());

    // 1. Add category column if missing
    if (!existingColumns.includes('category')) {
      await db.query("ALTER TABLE crops ADD COLUMN category VARCHAR(50) DEFAULT 'Other'");
      console.log('✅ Added column: category');
    } else {
      console.log('ℹ️ Column already exists: category (skipping)');
    }

    // 2. Add harvest_date column if missing
    if (!existingColumns.includes('harvest_date')) {
      await db.query("ALTER TABLE crops ADD COLUMN harvest_date DATE NULL");
      console.log('✅ Added column: harvest_date');
    } else {
      console.log('ℹ️ Column already exists: harvest_date (skipping)');
    }

    // 3. Add image column if missing (MEDIUMTEXT can store base64 images up to 16MB)
    if (!existingColumns.includes('image')) {
      await db.query("ALTER TABLE crops ADD COLUMN image MEDIUMTEXT NULL");
      console.log('✅ Added column: image');
    } else {
      console.log('ℹ️ Column already exists: image (skipping)');
    }

    console.log('🎉 Migration completed successfully!');
    process.exit(0);
  } catch (error) {
    console.error('❌ Migration failed:', error.message);
    process.exit(1);
  }
}

migrate();
