// ============================================================================
// FARM DIRECT — COMPLETE SUPER ADMIN & PLATFORM MANAGEMENT ROUTER
// ============================================================================

const express = require('express');
const bcrypt = require('bcrypt');
const db = require('../db');
const { verifyToken, requireRole, recordAuditLog } = require('../middleware/auth');

const router = express.Router();

// Middleware: All routes in /api/admin require admin or super_admin role
router.use(verifyToken, requireRole('admin', 'super_admin'));

// 1. LIVE PLATFORM METRICS & ANALYTICS OVERVIEW
router.get('/metrics', async (req, res) => {
  try {
    // A. User breakdown
    const [[userStats]] = await db.query(`
      SELECT 
        COUNT(*) AS total_users,
        SUM(CASE WHEN role = 'farmer' THEN 1 ELSE 0 END) AS total_farmers,
        SUM(CASE WHEN role = 'buyer' THEN 1 ELSE 0 END) AS total_buyers,
        SUM(CASE WHEN role = 'business_buyer' THEN 1 ELSE 0 END) AS total_business_buyers,
        SUM(CASE WHEN role = 'fpo_manager' THEN 1 ELSE 0 END) AS total_fpos,
        SUM(CASE WHEN role = 'delivery_partner' THEN 1 ELSE 0 END) AS total_delivery_partners,
        SUM(CASE WHEN status = 'suspended' THEN 1 ELSE 0 END) AS suspended_users
      FROM users
    `);

    // B. Crop listings breakdown
    const [[cropStats]] = await db.query(`
      SELECT 
        COUNT(*) AS total_listings,
        SUM(CASE WHEN quantity_available > 0 THEN 1 ELSE 0 END) AS active_listings,
        COALESCE(SUM(quantity_available), 0) AS total_stock_kg
      FROM crops
    `);

    // C. Order & Revenue breakdown
    const [[orderStats]] = await db.query(`
      SELECT 
        COUNT(*) AS total_orders,
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending_orders,
        SUM(CASE WHEN status = 'delivered' THEN 1 ELSE 0 END) AS completed_orders,
        SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled_orders,
        COALESCE(SUM(total_price), 0) AS total_gmv,
        COALESCE(SUM(CASE WHEN status = 'delivered' THEN total_price ELSE 0 END), 0) AS realized_volume
      FROM orders
    `);

    // D. Active Deliveries & Complaints & Certificates
    const [[delStats]] = await db.query(`
      SELECT COUNT(*) AS active_deliveries 
      FROM delivery_assignments 
      WHERE status IN ('assigned', 'picked_up', 'in_transit', 'out_for_delivery')
    `);

    const [[complaintStats]] = await db.query(`
      SELECT 
        COUNT(*) AS total_complaints,
        SUM(CASE WHEN status IN ('open', 'investigating') THEN 1 ELSE 0 END) AS open_complaints
      FROM complaints
    `);

    const [[certStats]] = await db.query(`
      SELECT 
        COUNT(*) AS total_certs,
        SUM(CASE WHEN verification_status = 'pending' THEN 1 ELSE 0 END) AS pending_certs
      FROM certificates
    `);

    // E. Monthly order trends (Last 6 months)
    const [monthlyTrends] = await db.query(`
      SELECT 
        DATE_FORMAT(created_at, '%Y-%m') AS month,
        COUNT(*) AS order_count,
        COALESCE(SUM(total_price), 0) AS volume
      FROM orders
      GROUP BY DATE_FORMAT(created_at, '%Y-%m')
      ORDER BY month DESC LIMIT 6
    `);

    // F. Top crops by volume
    const [topCrops] = await db.query(`
      SELECT crops.crop_name, COUNT(orders.id) AS orders_count, COALESCE(SUM(orders.quantity), 0) AS total_kg
      FROM orders
      JOIN crops ON orders.crop_id = crops.id
      GROUP BY crops.crop_name
      ORDER BY total_kg DESC LIMIT 5
    `);

    res.json({
      users: userStats || {},
      listings: cropStats || {},
      orders: orderStats || {},
      active_deliveries: delStats?.active_deliveries || 0,
      complaints: complaintStats || {},
      certificates: certStats || {},
      monthly_trends: monthlyTrends.reverse(),
      top_crops: topCrops
    });
  } catch (err) {
    console.error('GET /api/admin/metrics error:', err.message);
    res.status(500).json({ error: 'Failed to fetch platform metrics' });
  }
});

// 2. USER MANAGEMENT
router.get('/users', async (req, res) => {
  try {
    const { role, status, search } = req.query;
    let sql = `SELECT id, name, email, role, status, location, district, phone, is_verified, verification_status, created_at FROM users WHERE 1=1`;
    const params = [];

    if (role) {
      sql += ` AND role = ?`;
      params.push(role);
    }
    if (status) {
      sql += ` AND status = ?`;
      params.push(status);
    }
    if (search) {
      sql += ` AND (LOWER(name) LIKE ? OR LOWER(email) LIKE ? OR LOWER(location) LIKE ?)`;
      const q = `%${search.toLowerCase().trim()}%`;
      params.push(q, q, q);
    }

    sql += ` ORDER BY id DESC LIMIT 200`;
    const [users] = await db.query(sql, params);
    res.json(users);
  } catch (err) {
    console.error('GET /api/admin/users error:', err.message);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

// 3. ACTIVATE / SUSPEND USER ACCOUNT
router.put('/users/:id/status', async (req, res) => {
  try {
    const targetId = parseInt(req.params.id, 10);
    const { status, reason } = req.body;

    if (!['active', 'suspended', 'pending_approval'].includes(status)) {
      return res.status(400).json({ error: 'Invalid account status' });
    }

    // Prevent suspending self or super_admin
    const [target] = await db.query(`SELECT id, role, email FROM users WHERE id = ?`, [targetId]);
    if (target.length === 0) return res.status(404).json({ error: 'User not found' });
    if (target[0].role === 'super_admin' && req.user.role !== 'super_admin') {
      return res.status(403).json({ error: 'Cannot modify a Super Admin account' });
    }

    await db.query(`UPDATE users SET status = ? WHERE id = ?`, [status, targetId]);

    await recordAuditLog(
      req.user.id,
      req.user.role,
      `USER_STATUS_${status.toUpperCase()}`,
      'users',
      targetId,
      { target_email: target[0].email, reason: reason || 'Administrative action' },
      req
    );

    res.json({ message: `User account is now ${status}` });
  } catch (err) {
    console.error('PUT /api/admin/users/:id/status error:', err.message);
    res.status(500).json({ error: 'Failed to update user status' });
  }
});

// 4. VERIFY / UNVERIFY FARMER
router.put('/users/:id/verify-farmer', async (req, res) => {
  try {
    const targetId = parseInt(req.params.id, 10);
    const { is_verified, verification_status } = req.body;

    const verifiedBool = is_verified === true || is_verified === 'true' || is_verified === 1;
    const vStatus = verification_status || (verifiedBool ? 'verified' : 'unverified');

    await db.query(
      `UPDATE users SET is_verified = ?, verification_status = ? WHERE id = ? AND role = 'farmer'`,
      [verifiedBool, vStatus, targetId]
    );

    await recordAuditLog(
      req.user.id,
      req.user.role,
      verifiedBool ? 'VERIFY_FARMER' : 'REVOKE_FARMER_VERIFICATION',
      'users',
      targetId,
      { is_verified: verifiedBool, verification_status: vStatus },
      req
    );

    res.json({ message: `Farmer verification updated to: ${vStatus}` });
  } catch (err) {
    console.error('PUT /api/admin/users/:id/verify-farmer error:', err.message);
    res.status(500).json({ error: 'Failed to verify farmer' });
  }
});

// 5. CREATE / INVITE DELIVERY PARTNER (Admin only)
router.post('/create-delivery-partner', async (req, res) => {
  try {
    const { name, email, password, phone, location, vehicle_type, vehicle_number, operating_district } = req.body;
    if (!name || !email || !password) {
      return res.status(400).json({ error: 'Name, email, and initial password are required' });
    }

    const [existing] = await db.query('SELECT id FROM users WHERE email = ?', [email]);
    if (existing.length > 0) {
      return res.status(400).json({ error: 'An account with this email already exists' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const [result] = await db.query(
      `INSERT INTO users (name, email, password, role, status, phone, location, district, is_verified, verification_status)
       VALUES (?, ?, ?, 'delivery_partner', 'active', ?, ?, ?, TRUE, 'verified')`,
      [name.trim(), email.trim().toLowerCase(), hashedPassword, phone || '', location || '', operating_district || '']
    );

    const partnerId = result.insertId;

    // Create delivery_partner_profiles record
    await db.query(
      `INSERT INTO delivery_partner_profiles (user_id, vehicle_type, vehicle_number, operating_district, is_available)
       VALUES (?, ?, ?, ?, TRUE)`,
      [partnerId, vehicle_type || 'Cargo Van', vehicle_number || '', operating_district || '']
    );

    await recordAuditLog(
      req.user.id,
      req.user.role,
      'CREATE_DELIVERY_PARTNER',
      'users',
      partnerId,
      { name, email, vehicle_type, operating_district },
      req
    );

    res.status(201).json({ message: 'Delivery partner account created successfully', partner_id: partnerId });
  } catch (err) {
    console.error('POST /api/admin/create-delivery-partner error:', err.message);
    res.status(500).json({ error: 'Failed to create delivery partner account' });
  }
});

// 6. CROP LISTINGS MODERATION
router.get('/crops', async (req, res) => {
  try {
    const [crops] = await db.query(
      `SELECT crops.*, users.name AS farmer_name, users.location AS farmer_location, users.is_verified AS farmer_is_verified
       FROM crops
       JOIN users ON crops.farmer_id = users.id
       ORDER BY crops.id DESC LIMIT 200`
    );
    res.json(crops);
  } catch (err) {
    console.error('GET /api/admin/crops error:', err.message);
    res.status(500).json({ error: 'Failed to fetch crops' });
  }
});

// 7. ORDER MANAGEMENT & OVERRIDE
router.get('/orders', async (req, res) => {
  try {
    const { status, search } = req.query;
    let sql = `
      SELECT orders.*, 
             crops.crop_name, crops.price_per_kg,
             farmer.name AS farmer_name, buyer.name AS buyer_name,
             delivery_assignments.status AS delivery_status,
             delivery_partner.name AS delivery_partner_name
      FROM orders
      JOIN crops ON orders.crop_id = crops.id
      JOIN users AS farmer ON crops.farmer_id = farmer.id
      JOIN users AS buyer ON orders.buyer_id = buyer.id
      LEFT JOIN delivery_assignments ON orders.id = delivery_assignments.order_id
      LEFT JOIN users AS delivery_partner ON delivery_assignments.delivery_partner_id = delivery_partner.id
      WHERE 1=1
    `;
    const params = [];

    if (status) {
      sql += ` AND orders.status = ?`;
      params.push(status);
    }
    if (search) {
      sql += ` AND (orders.id = ? OR LOWER(crops.crop_name) LIKE ? OR LOWER(buyer.name) LIKE ? OR LOWER(farmer.name) LIKE ?)`;
      const s = `%${search.toLowerCase().trim()}%`;
      params.push(isNaN(parseInt(search)) ? 0 : parseInt(search), s, s, s);
    }

    sql += ` ORDER BY orders.id DESC LIMIT 200`;
    const [orders] = await db.query(sql, params);
    res.json(orders);
  } catch (err) {
    console.error('GET /api/admin/orders error:', err.message);
    res.status(500).json({ error: 'Failed to fetch orders' });
  }
});

// 8. ORDER STATUS OVERRIDE (Audited)
router.put('/orders/:id/override', async (req, res) => {
  try {
    const orderId = parseInt(req.params.id, 10);
    const { status, reason } = req.body;

    const [orders] = await db.query(`SELECT status FROM orders WHERE id = ?`, [orderId]);
    if (orders.length === 0) return res.status(404).json({ error: 'Order not found' });
    const oldStatus = orders[0].status;

    await db.query(`UPDATE orders SET status = ? WHERE id = ?`, [status, orderId]);
    await db.query(
      `INSERT INTO order_status_history (order_id, status, changed_by_user_id, actor_role, note)
       VALUES (?, ?, ?, 'admin', ?)`,
      [orderId, status, req.user.id, `Admin Override: ${reason || 'Status corrected by administrator'}`]
    );

    await recordAuditLog(
      req.user.id,
      req.user.role,
      'ADMIN_ORDER_STATUS_OVERRIDE',
      'orders',
      orderId,
      { old_status: oldStatus, new_status: status, reason },
      req
    );

    res.json({ message: `Order #${orderId} status overridden to ${status}` });
  } catch (err) {
    console.error('PUT /api/admin/orders/:id/override error:', err.message);
    res.status(500).json({ error: 'Failed to override order status' });
  }
});

// 9. AUDIT LOGS (Read-Only)
router.get('/audit-logs', async (req, res) => {
  try {
    const [logs] = await db.query(`
      SELECT audit_logs.*, users.name AS actor_name, users.email AS actor_email 
      FROM audit_logs
      LEFT JOIN users ON audit_logs.actor_id = users.id
      ORDER BY audit_logs.id DESC LIMIT 150
    `);

    const parsed = logs.map(l => ({
      ...l,
      details: typeof l.details === 'string' ? JSON.parse(l.details) : (l.details || {})
    }));

    res.json(parsed);
  } catch (err) {
    console.error('GET /api/admin/audit-logs error:', err.message);
    res.status(500).json({ error: 'Failed to fetch audit logs' });
  }
});

// 10. PLATFORM SETTINGS
router.get('/settings', async (req, res) => {
  try {
    const [settings] = await db.query(`SELECT * FROM platform_settings ORDER BY category, id`);
    res.json(settings);
  } catch (err) {
    console.error('GET /api/admin/settings error:', err.message);
    res.status(500).json({ error: 'Failed to fetch platform settings' });
  }
});

router.put('/settings', async (req, res) => {
  try {
    const { setting_key, setting_value } = req.body;
    if (!setting_key || setting_value == null) {
      return res.status(400).json({ error: 'setting_key and setting_value are required' });
    }

    await db.query(
      `UPDATE platform_settings SET setting_value = ?, updated_by = ? WHERE setting_key = ?`,
      [String(setting_value), req.user.id, setting_key]
    );

    await recordAuditLog(
      req.user.id,
      req.user.role,
      'UPDATE_PLATFORM_SETTING',
      'platform_settings',
      null,
      { setting_key, setting_value },
      req
    );

    res.json({ message: `Setting '${setting_key}' updated successfully` });
  } catch (err) {
    console.error('PUT /api/admin/settings error:', err.message);
    res.status(500).json({ error: 'Failed to update setting' });
  }
});

module.exports = router;
