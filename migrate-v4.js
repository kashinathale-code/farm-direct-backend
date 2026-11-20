// ============================================================================
// FARM DIRECT — DATABASE MIGRATION SCRIPT V4 (ADVANCED PLATFORM UPGRADE)
// ============================================================================
// Creates tables for:
// 1. Audit Logs
// 2. AI Crop Quality Assessments
// 3. NASA Satellite Soil Moisture Observations
// 4. Actual Laboratory Soil Test Reports
// 5. Farm Service Providers, Services, & Service Bookings
// 6. Delivery Partner Profiles, Assignments, Location Updates, & Delivery Proofs
// 7. Certificates & Verification
// 8. Invoices & Invoice Items
// 9. Complaints & Support Tickets
// 10. Platform Settings & RBAC Extensions
// ============================================================================

const db = require('./db');

async function migrateV4() {
  try {
    console.log('🌱 Starting Farm Direct Migration v4 (Advanced Platform Upgrade)...');

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

    // 1. EXTEND USERS TABLE FOR ADVANCED ROLES & STATUS
    if (await tableExists('users')) {
      // Modify role to VARCHAR(50) so all 7 roles can be stored seamlessly
      try {
        await db.query(`ALTER TABLE users MODIFY COLUMN role VARCHAR(50) NOT NULL DEFAULT 'buyer'`);
        console.log('✅ Updated users.role to VARCHAR(50)');
      } catch (err) {
        console.warn('Note modifying users.role:', err.message);
      }

      const userNewCols = [
        { name: 'status', def: "VARCHAR(50) DEFAULT 'active'" },
        { name: 'phone', def: 'VARCHAR(30) NULL' },
        { name: 'business_name', def: 'VARCHAR(150) NULL' },
        { name: 'gstin', def: 'VARCHAR(50) NULL' },
        { name: 'fpo_registration_number', def: 'VARCHAR(100) NULL' }
      ];

      for (const col of userNewCols) {
        if (!(await columnExists('users', col.name))) {
          await db.query(`ALTER TABLE users ADD COLUMN ${col.name} ${col.def}`);
          console.log(`✅ Added users.${col.name}`);
        }
      }
    }

    // 2. AUDIT LOGS TABLE
    if (!(await tableExists('audit_logs'))) {
      await db.query(`
        CREATE TABLE audit_logs (
          id INT AUTO_INCREMENT PRIMARY KEY,
          actor_id INT NULL,
          actor_role VARCHAR(50) NULL,
          action VARCHAR(100) NOT NULL,
          target_entity VARCHAR(100) NULL,
          target_id INT NULL,
          details JSON NULL,
          ip_address VARCHAR(50) NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          INDEX idx_actor (actor_id),
          INDEX idx_action (action),
          INDEX idx_created (created_at)
        )
      `);
      console.log('✅ Created table: audit_logs');
    }

    // 3. AI CROP QUALITY ASSESSMENTS TABLE
    if (!(await tableExists('crop_quality_assessments'))) {
      await db.query(`
        CREATE TABLE crop_quality_assessments (
          id INT AUTO_INCREMENT PRIMARY KEY,
          crop_id INT NULL,
          farmer_id INT NOT NULL,
          image_url MEDIUMTEXT NULL,
          crop_type_detected VARCHAR(100) NULL,
          quality_grade VARCHAR(50) NULL,
          confidence_score DECIMAL(5,2) NULL,
          visual_defects JSON NULL,
          observed_characteristics JSON NULL,
          recommendations TEXT NULL,
          status VARCHAR(50) DEFAULT 'completed',
          reviewed_by INT NULL,
          admin_notes TEXT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          INDEX idx_crop (crop_id),
          INDEX idx_farmer (farmer_id)
        )
      `);
      console.log('✅ Created table: crop_quality_assessments');
    }

    // 4. NASA SATELLITE SOIL MOISTURE OBSERVATIONS TABLE
    if (!(await tableExists('soil_observations'))) {
      await db.query(`
        CREATE TABLE soil_observations (
          id INT AUTO_INCREMENT PRIMARY KEY,
          farmer_id INT NULL,
          location_name VARCHAR(150) NOT NULL,
          latitude DECIMAL(10,8) NOT NULL,
          longitude DECIMAL(11,8) NOT NULL,
          sfmc DECIMAL(6,4) NULL,
          rzmc DECIMAL(6,4) NULL,
          gwettop DECIMAL(6,4) NULL,
          gwetroot DECIMAL(6,4) NULL,
          observation_date DATE NOT NULL,
          source VARCHAR(100) DEFAULT 'NASA POWER / SMAP Model',
          metadata JSON NULL,
          fetched_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          INDEX idx_coords (latitude, longitude),
          INDEX idx_date (observation_date)
        )
      `);
      console.log('✅ Created table: soil_observations');
    }

    // 5. ACTUAL LABORATORY SOIL TEST REPORTS TABLE
    if (!(await tableExists('soil_test_reports'))) {
      await db.query(`
        CREATE TABLE soil_test_reports (
          id INT AUTO_INCREMENT PRIMARY KEY,
          farmer_id INT NOT NULL,
          farm_location VARCHAR(200) NOT NULL,
          sample_date DATE NULL,
          testing_date DATE NULL,
          lab_name VARCHAR(150) NOT NULL,
          report_number VARCHAR(100) NULL,
          ph DECIMAL(4,2) NULL,
          nitrogen DECIMAL(7,2) NULL,
          phosphorus DECIMAL(7,2) NULL,
          potassium DECIMAL(7,2) NULL,
          organic_carbon DECIMAL(5,2) NULL,
          electrical_conductivity DECIMAL(6,2) NULL,
          soil_texture VARCHAR(100) NULL,
          document_url MEDIUMTEXT NULL,
          status ENUM('uploaded', 'pending_review', 'verified', 'rejected') DEFAULT 'pending_review',
          admin_notes TEXT NULL,
          verified_by INT NULL,
          verified_at TIMESTAMP NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          INDEX idx_farmer_soil (farmer_id),
          INDEX idx_status (status)
        )
      `);
      console.log('✅ Created table: soil_test_reports');
    }

    // 6. FARM SERVICE PROVIDERS & SERVICES & BOOKINGS
    if (!(await tableExists('farm_service_providers'))) {
      await db.query(`
        CREATE TABLE farm_service_providers (
          id INT AUTO_INCREMENT PRIMARY KEY,
          provider_name VARCHAR(150) NOT NULL,
          category VARCHAR(100) NOT NULL,
          contact_email VARCHAR(100) NULL,
          contact_phone VARCHAR(30) NULL,
          address TEXT NULL,
          district VARCHAR(100) NULL,
          state VARCHAR(100) NULL,
          description TEXT NULL,
          rating DECIMAL(3,2) DEFAULT 5.0,
          is_verified BOOLEAN DEFAULT TRUE,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);
      console.log('✅ Created table: farm_service_providers');
    }

    if (!(await tableExists('farm_services'))) {
      await db.query(`
        CREATE TABLE farm_services (
          id INT AUTO_INCREMENT PRIMARY KEY,
          provider_id INT NOT NULL,
          title VARCHAR(150) NOT NULL,
          service_type VARCHAR(100) NULL,
          price DECIMAL(10,2) NOT NULL,
          pricing_unit VARCHAR(50) DEFAULT 'per sample',
          description TEXT NULL,
          turnaround_days INT DEFAULT 3,
          is_active BOOLEAN DEFAULT TRUE,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          INDEX idx_provider (provider_id)
        )
      `);
      console.log('✅ Created table: farm_services');
    }

    if (!(await tableExists('service_bookings'))) {
      await db.query(`
        CREATE TABLE service_bookings (
          id INT AUTO_INCREMENT PRIMARY KEY,
          service_id INT NOT NULL,
          farmer_id INT NOT NULL,
          booking_date DATE NOT NULL,
          status ENUM('pending', 'confirmed', 'sample_collected', 'in_analysis', 'completed', 'cancelled') DEFAULT 'pending',
          farm_location TEXT NOT NULL,
          notes TEXT NULL,
          total_price DECIMAL(10,2) NOT NULL,
          report_url MEDIUMTEXT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          INDEX idx_farmer_booking (farmer_id),
          INDEX idx_service (service_id)
        )
      `);
      console.log('✅ Created table: service_bookings');
    }

    // 7. DELIVERY PARTNER PROFILES & ASSIGNMENTS & TRACKING
    if (!(await tableExists('delivery_partner_profiles'))) {
      await db.query(`
        CREATE TABLE delivery_partner_profiles (
          id INT AUTO_INCREMENT PRIMARY KEY,
          user_id INT NOT NULL UNIQUE,
          vehicle_type VARCHAR(50) NULL,
          vehicle_number VARCHAR(50) NULL,
          license_number VARCHAR(100) NULL,
          operating_district VARCHAR(100) NULL,
          current_latitude DECIMAL(10,8) NULL,
          current_longitude DECIMAL(11,8) NULL,
          is_available BOOLEAN DEFAULT TRUE,
          is_sharing_location BOOLEAN DEFAULT FALSE,
          last_location_update TIMESTAMP NULL,
          INDEX idx_user_partner (user_id)
        )
      `);
      console.log('✅ Created table: delivery_partner_profiles');
    }

    if (!(await tableExists('delivery_assignments'))) {
      await db.query(`
        CREATE TABLE delivery_assignments (
          id INT AUTO_INCREMENT PRIMARY KEY,
          order_id INT NOT NULL UNIQUE,
          delivery_partner_id INT NOT NULL,
          assigned_by INT NULL,
          status ENUM('assigned', 'picked_up', 'in_transit', 'out_for_delivery', 'delivered', 'failed', 'cancelled') DEFAULT 'assigned',
          pickup_time TIMESTAMP NULL,
          delivery_time TIMESTAMP NULL,
          estimated_delivery TIMESTAMP NULL,
          notes TEXT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          INDEX idx_order (order_id),
          INDEX idx_partner (delivery_partner_id)
        )
      `);
      console.log('✅ Created table: delivery_assignments');
    }

    if (!(await tableExists('delivery_location_updates'))) {
      await db.query(`
        CREATE TABLE delivery_location_updates (
          id INT AUTO_INCREMENT PRIMARY KEY,
          delivery_assignment_id INT NOT NULL,
          delivery_partner_id INT NOT NULL,
          latitude DECIMAL(10,8) NOT NULL,
          longitude DECIMAL(11,8) NOT NULL,
          heading DECIMAL(5,2) NULL,
          speed_kmh DECIMAL(5,2) NULL,
          recorded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          INDEX idx_assignment (delivery_assignment_id)
        )
      `);
      console.log('✅ Created table: delivery_location_updates');
    }

    if (!(await tableExists('delivery_proofs'))) {
      await db.query(`
        CREATE TABLE delivery_proofs (
          id INT AUTO_INCREMENT PRIMARY KEY,
          delivery_assignment_id INT NOT NULL,
          proof_type ENUM('pickup', 'delivery') NOT NULL,
          photo_url MEDIUMTEXT NULL,
          recipient_name VARCHAR(100) NULL,
          notes TEXT NULL,
          latitude DECIMAL(10,8) NULL,
          longitude DECIMAL(11,8) NULL,
          recorded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          INDEX idx_proof_assignment (delivery_assignment_id)
        )
      `);
      console.log('✅ Created table: delivery_proofs');
    }

    // 8. CERTIFICATES & AUDITED VERIFICATION
    if (!(await tableExists('certificates'))) {
      await db.query(`
        CREATE TABLE certificates (
          id INT AUTO_INCREMENT PRIMARY KEY,
          farmer_id INT NOT NULL,
          certificate_type VARCHAR(100) NOT NULL,
          certificate_number VARCHAR(100) NOT NULL,
          issuing_authority VARCHAR(150) NOT NULL,
          issue_date DATE NOT NULL,
          expiry_date DATE NOT NULL,
          document_url MEDIUMTEXT NULL,
          verification_status ENUM('pending', 'under_review', 'verified', 'rejected', 'expired') DEFAULT 'pending',
          rejection_reason TEXT NULL,
          verified_by INT NULL,
          verified_at TIMESTAMP NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          INDEX idx_farmer_cert (farmer_id),
          INDEX idx_cert_status (verification_status)
        )
      `);
      console.log('✅ Created table: certificates');
    }

    // 9. INVOICES & INVOICE ITEMS
    if (!(await tableExists('invoices'))) {
      await db.query(`
        CREATE TABLE invoices (
          id INT AUTO_INCREMENT PRIMARY KEY,
          invoice_number VARCHAR(50) UNIQUE NOT NULL,
          order_id INT NOT NULL UNIQUE,
          buyer_id INT NOT NULL,
          farmer_id INT NOT NULL,
          subtotal DECIMAL(10,2) NOT NULL,
          delivery_charges DECIMAL(10,2) DEFAULT 0,
          platform_fee DECIMAL(10,2) DEFAULT 0,
          tax_amount DECIMAL(10,2) DEFAULT 0,
          total_amount DECIMAL(10,2) NOT NULL,
          payment_method VARCHAR(50) DEFAULT 'Direct Pay',
          payment_status VARCHAR(50) DEFAULT 'completed',
          payment_ref VARCHAR(100) NULL,
          invoice_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          pdf_data MEDIUMTEXT NULL,
          INDEX idx_inv_order (order_id),
          INDEX idx_inv_buyer (buyer_id),
          INDEX idx_inv_farmer (farmer_id)
        )
      `);
      console.log('✅ Created table: invoices');
    }

    if (!(await tableExists('invoice_items'))) {
      await db.query(`
        CREATE TABLE invoice_items (
          id INT AUTO_INCREMENT PRIMARY KEY,
          invoice_id INT NOT NULL,
          crop_id INT NULL,
          crop_name VARCHAR(150) NOT NULL,
          quantity INT NOT NULL,
          unit_price DECIMAL(10,2) NOT NULL,
          total_price DECIMAL(10,2) NOT NULL,
          INDEX idx_inv_item (invoice_id)
        )
      `);
      console.log('✅ Created table: invoice_items');
    }

    // 10. COMPLAINTS & SUPPORT TICKETING
    if (!(await tableExists('complaints'))) {
      await db.query(`
        CREATE TABLE complaints (
          id INT AUTO_INCREMENT PRIMARY KEY,
          ticket_number VARCHAR(50) UNIQUE NOT NULL,
          user_id INT NOT NULL,
          user_role VARCHAR(50) NOT NULL,
          category ENUM('quality', 'delivery', 'payment', 'farmer_dispute', 'buyer_dispute', 'other') NOT NULL,
          order_id INT NULL,
          subject VARCHAR(200) NOT NULL,
          description TEXT NOT NULL,
          status ENUM('open', 'investigating', 'resolved', 'closed') DEFAULT 'open',
          priority ENUM('low', 'medium', 'high', 'urgent') DEFAULT 'medium',
          admin_notes TEXT NULL,
          resolved_by INT NULL,
          resolved_at TIMESTAMP NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          INDEX idx_user_complaints (user_id),
          INDEX idx_status_priority (status, priority)
        )
      `);
      console.log('✅ Created table: complaints');
    }

    // 11. PLATFORM SETTINGS
    if (!(await tableExists('platform_settings'))) {
      await db.query(`
        CREATE TABLE platform_settings (
          id INT AUTO_INCREMENT PRIMARY KEY,
          setting_key VARCHAR(100) UNIQUE NOT NULL,
          setting_value TEXT NOT NULL,
          category VARCHAR(50) DEFAULT 'general',
          updated_by INT NULL,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        )
      `);
      console.log('✅ Created table: platform_settings');

      // Seed baseline settings
      const defaultSettings = [
        ['platform_name', 'Farm Direct', 'general'],
        ['platform_fee_percent', '2.0', 'fees'],
        ['delivery_flat_rate', '40.0', 'delivery'],
        ['enable_ai_crop_assessment', 'true', 'features'],
        ['enable_nasa_soil_moisture', 'true', 'features'],
        ['enable_public_traceability', 'true', 'features'],
        ['require_listing_approval', 'false', 'moderation']
      ];
      for (const [key, val, cat] of defaultSettings) {
        await db.query(
          `INSERT IGNORE INTO platform_settings (setting_key, setting_value, category) VALUES (?, ?, ?)`,
          [key, val, cat]
        );
      }
      console.log('✅ Seeded baseline platform_settings');
    }

    console.log('✨ Farm Direct Migration v4 completed successfully!');
    if (require.main === module) process.exit(0);
  } catch (err) {
    console.error('❌ Migration v4 failed:', err.message);
    if (require.main === module) process.exit(1);
  }
}

if (require.main === module) {
  migrateV4();
}

module.exports = migrateV4;
