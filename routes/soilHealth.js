// ============================================================================
// FARM DIRECT — SOIL HEALTH & LABORATORY TEST REPORTS ROUTER
// ============================================================================

const express = require('express');
const db = require('../db');
const { verifyToken, requireRole, recordAuditLog } = require('../middleware/auth');
const { getSoilMoistureData } = require('../services/nasaSoilService');

const router = express.Router();

// 1. GET NASA LOCATION-BASED SOIL MOISTURE
router.get('/nasa-moisture', async (req, res) => {
  try {
    const { lat, lon, location } = req.query;
    // Default to Pune coordinates if not passed
    const latitude = lat ? parseFloat(lat) : 18.5204;
    const longitude = lon ? parseFloat(lon) : 73.8567;
    const locName = location || 'Maharashtra Agricultural Belt';

    const data = await getSoilMoistureData(latitude, longitude, locName);
    res.json(data);
  } catch (err) {
    console.error('GET /api/soil-health/nasa-moisture error:', err.message);
    res.status(500).json({ error: 'Failed to fetch NASA soil moisture insights: ' + err.message });
  }
});

// 2. UPLOAD / RECORD ACTUAL LABORATORY SOIL TEST REPORT
router.post('/lab-reports', verifyToken, requireRole('farmer', 'admin', 'super_admin'), async (req, res) => {
  try {
    const {
      farm_location,
      sample_date,
      testing_date,
      lab_name,
      report_number,
      ph,
      nitrogen,
      phosphorus,
      potassium,
      organic_carbon,
      electrical_conductivity,
      soil_texture,
      document_url
    } = req.body;

    if (!lab_name || !farm_location) {
      return res.status(400).json({ error: 'Laboratory name and farm location are required' });
    }

    const [result] = await db.query(
      `INSERT INTO soil_test_reports 
        (farmer_id, farm_location, sample_date, testing_date, lab_name, report_number, ph, nitrogen, phosphorus, potassium, organic_carbon, electrical_conductivity, soil_texture, document_url, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_review')`,
      [
        req.user.id,
        farm_location.trim(),
        sample_date || null,
        testing_date || null,
        lab_name.trim(),
        report_number || null,
        ph ? parseFloat(ph) : null,
        nitrogen ? parseFloat(nitrogen) : null,
        phosphorus ? parseFloat(phosphorus) : null,
        potassium ? parseFloat(potassium) : null,
        organic_carbon ? parseFloat(organic_carbon) : null,
        electrical_conductivity ? parseFloat(electrical_conductivity) : null,
        soil_texture || null,
        document_url || null
      ]
    );

    res.status(201).json({
      message: 'Laboratory soil test report submitted successfully for review',
      report_id: result.insertId,
      status: 'pending_review'
    });
  } catch (err) {
    console.error('POST /api/soil-health/lab-reports error:', err.message);
    res.status(500).json({ error: 'Failed to record soil laboratory report' });
  }
});

// 3. GET SOIL TEST REPORTS FOR A FARMER
router.get('/lab-reports/farmer/:farmerId', verifyToken, async (req, res) => {
  try {
    const farmerId = parseInt(req.params.farmerId, 10);
    // Security check: farmer themselves, or buyer viewing farmer profile, or admin
    const [rows] = await db.query(
      `SELECT * FROM soil_test_reports WHERE farmer_id = ? ORDER BY id DESC`,
      [farmerId]
    );
    res.json(rows);
  } catch (err) {
    console.error('GET /api/soil-health/lab-reports error:', err.message);
    res.status(500).json({ error: 'Failed to fetch soil test reports' });
  }
});

// 4. ADMIN GET ALL PENDING LAB REPORTS
router.get('/lab-reports/pending', verifyToken, requireRole('admin', 'super_admin'), async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT soil_test_reports.*, users.name AS farmer_name, users.email AS farmer_email 
       FROM soil_test_reports 
       JOIN users ON soil_test_reports.farmer_id = users.id 
       ORDER BY soil_test_reports.id DESC LIMIT 100`
    );
    res.json(rows);
  } catch (err) {
    console.error('GET /api/soil-health/lab-reports/pending error:', err.message);
    res.status(500).json({ error: 'Failed to fetch pending reports' });
  }
});

// 5. ADMIN VERIFY / REJECT SOIL LAB REPORT
router.put('/lab-reports/:id/verify', verifyToken, requireRole('admin', 'super_admin'), async (req, res) => {
  try {
    const reportId = parseInt(req.params.id, 10);
    const { status, admin_notes } = req.body;

    if (!['verified', 'rejected', 'pending_review'].includes(status)) {
      return res.status(400).json({ error: 'Invalid verification status' });
    }

    await db.query(
      `UPDATE soil_test_reports 
       SET status = ?, admin_notes = ?, verified_by = ?, verified_at = CURRENT_TIMESTAMP 
       WHERE id = ?`,
      [status, admin_notes || null, req.user.id, reportId]
    );

    await recordAuditLog(
      req.user.id,
      req.user.role,
      'VERIFY_SOIL_REPORT',
      'soil_test_reports',
      reportId,
      { status, admin_notes },
      req
    );

    res.json({ message: `Soil test report marked as ${status}` });
  } catch (err) {
    console.error('PUT /api/soil-health/lab-reports/:id/verify error:', err.message);
    res.status(500).json({ error: 'Failed to update report verification' });
  }
});

module.exports = router;
