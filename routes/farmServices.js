// ============================================================================
// FARM DIRECT — FARM SERVICES MARKETPLACE ROUTER
// ============================================================================

const express = require('express');
const db = require('../db');
const { verifyToken, requireRole, recordAuditLog } = require('../middleware/auth');

const router = express.Router();

// Baseline verified agricultural service providers in India
const SEED_PROVIDERS = [
  {
    name: 'MahaAgro Soil & Water Testing Laboratory',
    category: 'Soil Testing Laboratory',
    email: 'info@mahaagro-labs.org',
    phone: '+91 20 2553 4412',
    address: 'Gultekdi Market Yard, Pune, Maharashtra',
    district: 'Pune',
    state: 'Maharashtra',
    description: 'NABL-accredited full 12-parameter soil health testing, micro-nutrient analysis, and organic carbon assay.'
  },
  {
    name: 'Nashik Agro-Tech Advisory Services',
    category: 'Agricultural Consultant',
    email: 'contact@nashikagrotech.in',
    phone: '+91 253 234 8871',
    address: 'Panchavati Agro Hub, Nashik, Maharashtra',
    district: 'Nashik',
    state: 'Maharashtra',
    description: 'Specialized horticultural consulting for onions, grapes, and pomegranate cropping.'
  },
  {
    name: 'KisanCare Mobile Sample Collection',
    category: 'Soil Sample Collection',
    email: 'service@kisancare.co.in',
    phone: '+91 712 289 1100',
    address: 'Kalamna Mandi Corridor, Nagpur, Maharashtra',
    district: 'Nagpur',
    state: 'Maharashtra',
    description: 'Doorstep GPS-tagged soil sample collection directly from your farm field with cold-chain transport to lab.'
  }
];

// Helper to ensure baseline providers exist
async function ensureSeedProviders() {
  try {
    const [[{ count }]] = await db.query(`SELECT COUNT(*) AS count FROM farm_service_providers`);
    if (count === 0) {
      for (const p of SEED_PROVIDERS) {
        const [res] = await db.query(
          `INSERT INTO farm_service_providers 
            (provider_name, category, contact_email, contact_phone, address, district, state, description, is_verified)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, TRUE)`,
          [p.name, p.category, p.email, p.phone, p.address, p.district, p.state, p.description]
        );
        const pId = res.insertId;
        // Insert standard services
        await db.query(
          `INSERT INTO farm_services (provider_id, title, service_type, price, pricing_unit, description)
           VALUES 
             (?, 'Comprehensive 12-Parameter Soil Card', 'Laboratory Test', 450.00, 'per soil sample', 'Tests pH, N, P, K, Organic Carbon, Zinc, Boron, EC, and texture.'),
             (?, 'Express Field Sample Collection & GPS Tagging', 'Sample Collection', 250.00, 'per visit', 'Trained field technician collects 5-point composite sample from your farm.')`,
          [pId, pId]
        );
      }
    }
  } catch (err) {
    console.warn('Seed providers note:', err.message);
  }
}

// 1. GET ALL SERVICE PROVIDERS
router.get('/providers', async (req, res) => {
  try {
    await ensureSeedProviders();
    const { category, district } = req.query;

    let sql = `SELECT * FROM farm_service_providers WHERE 1=1`;
    const params = [];

    if (category) {
      sql += ` AND LOWER(category) = LOWER(?)`;
      params.push(category.trim());
    }
    if (district) {
      sql += ` AND LOWER(district) = LOWER(?)`;
      params.push(district.trim());
    }

    sql += ` ORDER BY id ASC`;
    const [providers] = await db.query(sql, params);
    res.json(providers);
  } catch (err) {
    console.error('GET /api/farm-services/providers error:', err.message);
    res.status(500).json({ error: 'Failed to fetch service providers' });
  }
});

// 2. GET ALL AVAILABLE SERVICES
router.get('/services', async (req, res) => {
  try {
    await ensureSeedProviders();
    const [services] = await db.query(
      `SELECT farm_services.*, farm_service_providers.provider_name, farm_service_providers.district, farm_service_providers.category 
       FROM farm_services 
       JOIN farm_service_providers ON farm_services.provider_id = farm_service_providers.id 
       WHERE farm_services.is_active = TRUE
       ORDER BY farm_services.id ASC`
    );
    res.json(services);
  } catch (err) {
    console.error('GET /api/farm-services/services error:', err.message);
    res.status(500).json({ error: 'Failed to fetch services list' });
  }
});

// 3. BOOK A SERVICE (Farmer only)
router.post('/book', verifyToken, requireRole('farmer', 'admin', 'super_admin'), async (req, res) => {
  try {
    const { service_id, booking_date, farm_location, notes } = req.body;
    if (!service_id || !booking_date || !farm_location) {
      return res.status(400).json({ error: 'service_id, booking_date, and farm_location are required' });
    }

    const [services] = await db.query(`SELECT * FROM farm_services WHERE id = ?`, [service_id]);
    if (services.length === 0) return res.status(404).json({ error: 'Service not found' });
    const service = services[0];

    const [result] = await db.query(
      `INSERT INTO service_bookings (service_id, farmer_id, booking_date, farm_location, notes, total_price, status)
       VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
      [service.id, req.user.id, booking_date, farm_location.trim(), notes || '', service.price]
    );

    res.status(201).json({
      message: 'Service booked successfully! The provider will contact you to coordinate.',
      booking_id: result.insertId,
      status: 'pending'
    });
  } catch (err) {
    console.error('POST /api/farm-services/book error:', err.message);
    res.status(500).json({ error: 'Failed to book agricultural service' });
  }
});

// 4. GET BOOKINGS FOR A FARMER
router.get('/bookings/farmer/:farmerId', verifyToken, async (req, res) => {
  try {
    const farmerId = parseInt(req.params.farmerId, 10);
    if (req.user.id !== farmerId && !['admin', 'super_admin'].includes(req.user.role)) {
      return res.status(403).json({ error: 'Not authorized to view these bookings' });
    }

    const [rows] = await db.query(
      `SELECT service_bookings.*, farm_services.title AS service_title, farm_services.pricing_unit, farm_service_providers.provider_name, farm_service_providers.contact_phone 
       FROM service_bookings 
       JOIN farm_services ON service_bookings.service_id = farm_services.id 
       JOIN farm_service_providers ON farm_services.provider_id = farm_service_providers.id 
       WHERE service_bookings.farmer_id = ?
       ORDER BY service_bookings.id DESC`,
      [farmerId]
    );
    res.json(rows);
  } catch (err) {
    console.error('GET /api/farm-services/bookings/farmer error:', err.message);
    res.status(500).json({ error: 'Failed to fetch bookings' });
  }
});

// 5. ADMIN VIEW ALL BOOKINGS
router.get('/bookings/all', verifyToken, requireRole('admin', 'super_admin'), async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT service_bookings.*, farm_services.title AS service_title, farm_service_providers.provider_name, users.name AS farmer_name, users.phone AS farmer_phone 
       FROM service_bookings 
       JOIN farm_services ON service_bookings.service_id = farm_services.id 
       JOIN farm_service_providers ON farm_services.provider_id = farm_service_providers.id 
       JOIN users ON service_bookings.farmer_id = users.id 
       ORDER BY service_bookings.id DESC LIMIT 100`
    );
    res.json(rows);
  } catch (err) {
    console.error('GET /api/farm-services/bookings/all error:', err.message);
    res.status(500).json({ error: 'Failed to fetch all bookings' });
  }
});

// 6. UPDATE BOOKING STATUS
router.put('/bookings/:id/status', verifyToken, requireRole('admin', 'super_admin'), async (req, res) => {
  try {
    const bookingId = parseInt(req.params.id, 10);
    const { status, report_url } = req.body;

    await db.query(
      `UPDATE service_bookings SET status = ?, report_url = COALESCE(?, report_url) WHERE id = ?`,
      [status, report_url || null, bookingId]
    );

    res.json({ message: 'Booking status updated successfully' });
  } catch (err) {
    console.error('PUT /api/farm-services/bookings/status error:', err.message);
    res.status(500).json({ error: 'Failed to update booking status' });
  }
});

module.exports = router;
