const express = require('express');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const db = require('../db');
require('dotenv').config();

const router = express.Router();

// Whitelist of valid crop categories
const ALLOWED_CATEGORIES = ['Vegetables', 'Fruits', 'Grains', 'Pulses', 'Spices', 'Other'];

// Helper to validate and sanitize base64 crop image
// Must be JPEG format and under 400KB in size
function sanitizeCropImage(image) {
  if (!image || typeof image !== 'string') return null;
  // Check for JPEG base64 data URL header and characters
  const isJpegBase64 = /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(image);
  if (!isJpegBase64) return null;
  // Ensure size is under 400KB (400 * 1024 bytes)
  const byteSize = Buffer.byteLength(image, 'utf8');
  if (byteSize > 400 * 1024) return null;
  return image;
}

// Helper to validate category against allowed whitelist
function validateCategory(category) {
  if (!category) return 'Other';
  if (!ALLOWED_CATEGORIES.includes(category)) return null;
  return category;
}

// Helper to sanitize harvest date (YYYY-MM-DD or valid date string)
function sanitizeHarvestDate(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return null;
  return dateStr;
}

// Middleware to verify JWT token
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

// 1. GET ALL CROPS (Marketplace view for buyers - hides private min_bidding_price)
router.get('/', async (req, res) => {
  try {
    const [crops] = await db.query(
      `SELECT 
         crops.id, 
         crops.farmer_id, 
         crops.crop_name, 
         crops.price_per_kg, 
         crops.quantity_available, 
         crops.quantity_available AS quantity,
         crops.description,
         crops.category,
         crops.harvest_date,
         crops.image,
         crops.bidding_enabled,
         crops.traceability_code,
         users.name AS farmer_name, 
         users.location 
       FROM crops 
       JOIN users ON crops.farmer_id = users.id 
       ORDER BY crops.id DESC`
    );
    res.json(crops);
  } catch (err) {
    console.error("GET /api/crops Error:", err);
    res.status(500).json({ error: 'Server error while fetching crops' });
  }
});

// 2. GET STATS FOR FARMER (Excludes heavy image column for performance)
router.get('/stats/farmer/:id', verifyToken, async (req, res) => {
  try {
    const [[stats]] = await db.query(
      `SELECT 
         COUNT(*) AS totalCrops,
         COALESCE(SUM(quantity_available), 0) AS totalStock,
         COALESCE(SUM(CASE WHEN quantity_available < 5 THEN 1 ELSE 0 END), 0) AS lowStockCount
       FROM crops 
       WHERE farmer_id = ?`,
      [req.params.id]
    );
    res.json(stats || { totalCrops: 0, totalStock: 0, lowStockCount: 0 });
  } catch (err) {
    console.error("GET /api/crops/stats/farmer Error:", err);
    res.status(500).json({ error: 'Server error while fetching crop stats' });
  }
});

// 3. GET CROPS BY FARMER ID (For farmer's dashboard listing)
router.get('/farmer/:id', verifyToken, async (req, res) => {
  try {
    const [crops] = await db.query(
      `SELECT * FROM crops WHERE farmer_id = ? ORDER BY id DESC`,
      [req.params.id]
    );
    res.json(crops);
  } catch (err) {
    console.error("GET /api/crops/farmer Error:", err);
    res.status(500).json({ error: 'Server error while fetching farmer crops' });
  }
});

// 4. POST NEW CROP (Includes photo, category, and harvest date)
router.post('/', verifyToken, async (req, res) => {
  try {
    if (req.user.role !== 'farmer') {
      return res.status(403).json({ error: 'Only farmers can add crops' });
    }

    // Accepts either naming convention sent by frontend
    const crop_name = req.body.name || req.body.crop_name;
    const price_per_kg = req.body.price || req.body.price_per_kg;
    const quantity_available = req.body.quantity || req.body.quantity_available || 0;
    const description = req.body.description || '';
    const raw_category = req.body.category || 'Other';
    const harvest_date = sanitizeHarvestDate(req.body.harvest_date);
    const image = sanitizeCropImage(req.body.image);
    const bidding_enabled = req.body.bidding_enabled === true || req.body.bidding_enabled === 'true';
    const min_bidding_price = req.body.min_bidding_price ? parseFloat(req.body.min_bidding_price) : null;
    const traceability_code = 'FD-' + crypto.randomBytes(4).toString('hex').toUpperCase();

    if (!crop_name || !price_per_kg) {
      return res.status(400).json({ error: 'Crop name and price are required' });
    }

    // Reject unknown categories
    const category = validateCategory(raw_category);
    if (!category) {
      return res.status(400).json({ error: 'Invalid category' });
    }

    const [result] = await db.query(
      `INSERT INTO crops 
       (farmer_id, crop_name, price_per_kg, quantity_available, description, category, harvest_date, image, bidding_enabled, min_bidding_price, traceability_code) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [req.user.id, crop_name, price_per_kg, quantity_available, description, category, harvest_date, image, bidding_enabled, min_bidding_price, traceability_code]
    );

    res.status(201).json({ message: 'Crop added successfully', id: result.insertId, cropId: result.insertId, traceability_code });
  } catch (err) {
    console.error("POST /api/crops Error:", err);
    res.status(500).json({ error: 'Server error while adding crop' });
  }
});

// 5. UPDATE CROP (Keeps old image if no new one sent)
router.put('/:id', verifyToken, async (req, res) => {
  try {
    const crop_name = req.body.name || req.body.crop_name;
    const price_per_kg = req.body.price || req.body.price_per_kg;
    const quantity_available = req.body.quantity || req.body.quantity_available || 0;
    const description = req.body.description || '';

    const [crops] = await db.query('SELECT * FROM crops WHERE id = ?', [req.params.id]);
    if (crops.length === 0) return res.status(404).json({ error: 'Crop not found' });

    if (crops[0].farmer_id !== req.user.id) {
      return res.status(403).json({ error: 'Not authorized to edit this crop' });
    }

    // Category update: keep existing or validate new
    let category = crops[0].category || 'Other';
    if (req.body.category !== undefined) {
      category = validateCategory(req.body.category);
      if (!category) {
        return res.status(400).json({ error: 'Invalid category' });
      }
    }

    // Harvest date update: keep existing or sanitize new
    let harvest_date = crops[0].harvest_date;
    if (req.body.harvest_date !== undefined) {
      harvest_date = sanitizeHarvestDate(req.body.harvest_date);
    }

    // Image update: keep existing if image field is omitted (undefined)
    let image = crops[0].image;
    if (req.body.image !== undefined) {
      // Validate new image (or NULL if invalid / cleared)
      image = sanitizeCropImage(req.body.image);
    }

    // Bidding updates
    let bidding_enabled = crops[0].bidding_enabled;
    if (req.body.bidding_enabled !== undefined) {
      bidding_enabled = req.body.bidding_enabled === true || req.body.bidding_enabled === 'true';
    }

    let min_bidding_price = crops[0].min_bidding_price;
    if (req.body.min_bidding_price !== undefined) {
      min_bidding_price = req.body.min_bidding_price ? parseFloat(req.body.min_bidding_price) : null;
    }

    await db.query(
      `UPDATE crops 
       SET crop_name = ?, price_per_kg = ?, quantity_available = ?, description = ?, category = ?, harvest_date = ?, image = ?, bidding_enabled = ?, min_bidding_price = ? 
       WHERE id = ?`,
      [crop_name, price_per_kg, quantity_available, description, category, harvest_date, image, bidding_enabled, min_bidding_price, req.params.id]
    );

    res.json({ message: 'Crop updated successfully' });
  } catch (err) {
    console.error("PUT /api/crops Error:", err);
    res.status(500).json({ error: 'Server error while updating crop' });
  }
});

// 6. DELETE CROP
router.delete('/:id', verifyToken, async (req, res) => {
  try {
    const [crops] = await db.query('SELECT * FROM crops WHERE id = ?', [req.params.id]);
    if (crops.length === 0) return res.status(404).json({ error: 'Crop not found' });

    if (crops[0].farmer_id !== req.user.id) {
      return res.status(403).json({ error: 'Not authorized to delete this crop' });
    }

    await db.query('DELETE FROM crops WHERE id = ?', [req.params.id]);
    res.json({ message: 'Crop deleted successfully' });
  } catch (err) {
    console.error("DELETE /api/crops Error:", err);
    res.status(500).json({ error: 'Server error while deleting crop' });
  }
});

module.exports = router;