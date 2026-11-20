const express = require('express');
const jwt = require('jsonwebtoken');
const db = require('../db');
require('dotenv').config();

const router = express.Router();

function verifyToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token provided' });

  jwt.verify(token, process.env.JWT_SECRET || 'fallback_secret', (err, decoded) => {
    if (err) return res.status(403).json({ error: 'Invalid or expired token' });
    req.user = decoded;
    next();
  });
}

// 1. GET ALL HARVEST PLANS FOR LOGGED-IN FARMER
router.get('/', verifyToken, async (req, res) => {
  try {
    if (req.user.role !== 'farmer') {
      return res.status(403).json({ error: 'Only farmers can manage harvest plans' });
    }

    const [plans] = await db.query(
      `SELECT * FROM harvest_calendar WHERE farmer_id = ? ORDER BY expected_harvest_date ASC`,
      [req.user.id]
    );

    res.json(plans);
  } catch (err) {
    console.error('GET /api/harvest-calendar error:', err.message);
    res.status(500).json({ error: 'Failed to fetch harvest calendar' });
  }
});

// 2. CREATE A HARVEST PLAN
router.post('/', verifyToken, async (req, res) => {
  try {
    if (req.user.role !== 'farmer') {
      return res.status(403).json({ error: 'Only farmers can create harvest plans' });
    }

    const {
      crop_name,
      category,
      acreage,
      expected_quantity_kg,
      planting_date,
      expected_harvest_date,
      status,
      notes
    } = req.body;

    if (!crop_name || !expected_harvest_date) {
      return res.status(400).json({ error: 'Crop name and expected harvest date are required' });
    }

    const [result] = await db.query(
      `INSERT INTO harvest_calendar 
         (farmer_id, crop_name, category, acreage, expected_quantity_kg, planting_date, expected_harvest_date, status, notes) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        req.user.id,
        crop_name.trim(),
        category || 'Vegetables',
        acreage ? parseFloat(acreage) : null,
        expected_quantity_kg ? parseFloat(expected_quantity_kg) : 0,
        planting_date || null,
        expected_harvest_date,
        status || 'growing',
        notes ? notes.trim() : null
      ]
    );

    res.status(201).json({
      message: 'Harvest plan created successfully',
      planId: result.insertId
    });
  } catch (err) {
    console.error('POST /api/harvest-calendar error:', err.message);
    res.status(500).json({ error: 'Failed to create harvest plan' });
  }
});

// 3. UPDATE HARVEST PLAN STATUS / DETAILS
router.put('/:id', verifyToken, async (req, res) => {
  try {
    const {
      crop_name,
      category,
      acreage,
      expected_quantity_kg,
      planting_date,
      expected_harvest_date,
      status,
      notes
    } = req.body;

    // Verify ownership
    const [existing] = await db.query(
      `SELECT * FROM harvest_calendar WHERE id = ? AND farmer_id = ?`,
      [req.params.id, req.user.id]
    );

    if (existing.length === 0) {
      return res.status(404).json({ error: 'Harvest plan not found or unauthorized' });
    }

    await db.query(
      `UPDATE harvest_calendar SET 
         crop_name = COALESCE(?, crop_name),
         category = COALESCE(?, category),
         acreage = COALESCE(?, acreage),
         expected_quantity_kg = COALESCE(?, expected_quantity_kg),
         planting_date = COALESCE(?, planting_date),
         expected_harvest_date = COALESCE(?, expected_harvest_date),
         status = COALESCE(?, status),
         notes = COALESCE(?, notes)
       WHERE id = ?`,
      [
        crop_name ? crop_name.trim() : null,
        category || null,
        acreage !== undefined ? parseFloat(acreage) : null,
        expected_quantity_kg !== undefined ? parseFloat(expected_quantity_kg) : null,
        planting_date || null,
        expected_harvest_date || null,
        status || null,
        notes !== undefined ? notes : null,
        req.params.id
      ]
    );

    res.json({ message: 'Harvest plan updated successfully' });
  } catch (err) {
    console.error('PUT /api/harvest-calendar/:id error:', err.message);
    res.status(500).json({ error: 'Failed to update harvest plan' });
  }
});

// 4. DELETE A HARVEST PLAN
router.delete('/:id', verifyToken, async (req, res) => {
  try {
    const [result] = await db.query(
      `DELETE FROM harvest_calendar WHERE id = ? AND farmer_id = ?`,
      [req.params.id, req.user.id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Harvest plan not found' });
    }

    res.json({ message: 'Harvest plan deleted successfully' });
  } catch (err) {
    console.error('DELETE /api/harvest-calendar/:id error:', err.message);
    res.status(500).json({ error: 'Failed to delete harvest plan' });
  }
});

// 5. PUBLIC UPCOMING HARVESTS (Allows buyers to view future harvest availability)
router.get('/public', async (req, res) => {
  try {
    const { district, category } = req.query;

    const [rows] = await db.query(
      `SELECT 
         harvest_calendar.id,
         harvest_calendar.crop_name,
         harvest_calendar.category,
         harvest_calendar.expected_quantity_kg,
         harvest_calendar.expected_harvest_date,
         harvest_calendar.status,
         users.name AS farmer_name,
         users.district AS farmer_district,
         users.state AS farmer_state,
         users.is_verified AS farmer_is_verified
       FROM harvest_calendar
       JOIN users ON harvest_calendar.farmer_id = users.id
       WHERE harvest_calendar.status IN ('planted', 'growing', 'ready_for_harvest')
         AND harvest_calendar.expected_harvest_date >= CURDATE()
         AND (? IS NULL OR users.district = ?)
         AND (? IS NULL OR harvest_calendar.category = ?)
       ORDER BY harvest_calendar.expected_harvest_date ASC
       LIMIT 30`,
      [district || null, district || null, category || null, category || null]
    );

    res.json(rows);
  } catch (err) {
    console.error('GET /api/harvest-calendar/public error:', err.message);
    res.status(500).json({ error: 'Failed to fetch public harvest forecasts' });
  }
});

module.exports = router;
