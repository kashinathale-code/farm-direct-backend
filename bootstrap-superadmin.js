// ============================================================================
// FARM DIRECT — SECURE SUPER ADMIN BOOTSTRAP SCRIPT
// ============================================================================
// Creates the initial super_admin account safely.
// Usage:
//   node bootstrap-superadmin.js [email] [password] [name]
// Or via environment variables:
//   SUPERADMIN_EMAIL=admin@farmdirect.in SUPERADMIN_PASSWORD=MyPass123 node bootstrap-superadmin.js
// ============================================================================

const bcrypt = require('bcrypt');
const db = require('./db');
require('dotenv').config();

async function bootstrapSuperAdmin() {
  try {
    console.log('🛡️  Starting Super Admin Bootstrap Process...');

    const email = process.argv[2] || process.env.SUPERADMIN_EMAIL || 'admin@farmdirect.in';
    const password = process.argv[3] || process.env.SUPERADMIN_PASSWORD || 'FarmDirect@Admin2026!';
    const name = process.argv[4] || process.env.SUPERADMIN_NAME || 'Super Administrator';

    // 1. Check if super_admin already exists
    const [existing] = await db.query(
      `SELECT id, email, role, status FROM users WHERE role = 'super_admin' OR email = ?`,
      [email]
    );

    if (existing.length > 0) {
      const u = existing[0];
      if (u.role === 'super_admin') {
        console.log(`ℹ️  A Super Admin account already exists (ID: ${u.id}, Email: ${u.email}).`);
        console.log('Skipping creation to prevent duplicate or unauthorized privilege escalation.');
        process.exit(0);
      } else {
        // Upgrade existing user to super_admin safely if matching email
        const hashedPassword = await bcrypt.hash(password, 10);
        await db.query(
          `UPDATE users SET role = 'super_admin', status = 'active', password = ? WHERE id = ?`,
          [hashedPassword, u.id]
        );
        console.log(`✅ Existing user (${email}) upgraded to role 'super_admin'.`);
        process.exit(0);
      }
    }

    // 2. Hash password with bcrypt
    const hashedPassword = await bcrypt.hash(password, 10);

    // 3. Insert super_admin record
    const [result] = await db.query(
      `INSERT INTO users (name, email, password, role, status, location, is_verified, verification_status) 
       VALUES (?, ?, ?, 'super_admin', 'active', 'National HQ, India', TRUE, 'verified')`,
      [name, email, hashedPassword]
    );

    const adminId = result.insertId;
    console.log(`🎉 Super Admin created successfully!`);
    console.log(`   ID: ${adminId}`);
    console.log(`   Email: ${email}`);
    console.log(`   Role: super_admin`);
    console.log(`   Status: active`);

    // 4. Log in audit_logs if table exists
    try {
      await db.query(
        `INSERT INTO audit_logs (actor_id, actor_role, action, target_entity, target_id, details)
         VALUES (?, 'super_admin', 'BOOTSTRAP_SUPERADMIN', 'users', ?, ?)`,
        [adminId, adminId, JSON.stringify({ email, method: 'bootstrap_script' })]
      );
    } catch (auditErr) {
      // ignore if audit_logs table not yet migrated
    }

    process.exit(0);
  } catch (err) {
    console.error('❌ Bootstrap failed:', err.message);
    process.exit(1);
  }
}

bootstrapSuperAdmin();
