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

// 1. GET ALL WISHLIST CROPS FOR BUYER
router.get('/', verifyToken, async (req, res) => {
  try {
    const [items] = await db.query(
      `SELECT 
         wishlists.id AS wishlist_id,
         wishlists.created_at AS added_at,
         crops.id,
         crops.farmer_id,
         crops.crop_name,
         crops.category,
         crops.price_per_kg,
         crops.quantity_available,
         crops.harvest_date,
         crops.image,
         crops.description,
         crops.bulk_pricing,
         crops.traceability_code,
         users.name AS farmer_name,
         users.location AS farmer_location,
         users.district AS farmer_district,
         users.is_verified AS farmer_is_verified
       FROM wishlists
       JOIN crops ON wishlists.crop_id = crops.id
       JOIN users ON crops.farmer_id = users.id
       WHERE wishlists.buyer_id = ?
       ORDER BY wishlists.created_at DESC`,
      [req.user.id]
    );

    // Parse bulk_pricing JSON safely
    const formatted = items.map(c => {
      let bulk = null;
      if (c.bulk_pricing) {
        try {
          bulk = typeof c.bulk_pricing === 'string' ? JSON.parse(c.bulk_pricing) : c.bulk_pricing;
        } catch (e) {
          bulk = null;
        }
      }
      return { ...c, bulk_pricing: bulk };
    });

    res.json(formatted);
  } catch (err) {
    console.error('GET /api/wishlist error:', err.message);
    res.status(500).json({ error: 'Failed to fetch wishlist' });
  }
});

// 2. CHECK IF CROP IS IN WISHLIST
router.get('/check/:cropId', verifyToken, async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT id FROM wishlists WHERE buyer_id = ? AND crop_id = ?`,
      [req.user.id, req.params.cropId]
    );
    res.json({ in_wishlist: rows.length > 0 });
  } catch (err) {
    console.error('GET /api/wishlist/check error:', err.message);
    res.status(500).json({ error: 'Failed to check wishlist status' });
  }
});

// 3. ADD CROP TO WISHLIST
router.post('/', verifyToken, async (req, res) => {
  try {
    const { crop_id } = req.body;
    if (!crop_id) {
      return res.status(400).json({ error: 'crop_id is required' });
    }

    // Verify crop exists
    const [crops] = await db.query(`SELECT id FROM crops WHERE id = ?`, [crop_id]);
    if (crops.length === 0) {
      return res.status(404).json({ error: 'Crop listing not found' });
    }

    // Prevent duplicate entries
    const [existing] = await db.query(
      `SELECT id FROM wishlists WHERE buyer_id = ? AND crop_id = ?`,
      [req.user.id, crop_id]
    );

    if (existing.length > 0) {
      return res.json({ message: 'Crop is already in wishlist', wishlist_id: existing[0].id });
    }

    const [result] = await db.query(
      `INSERT INTO wishlists (buyer_id, crop_id) VALUES (?, ?)`,
      [req.user.id, crop_id]
    );

    res.status(201).json({ message: 'Crop added to wishlist', wishlist_id: result.insertId });
  } catch (err) {
    console.error('POST /api/wishlist error:', err.message);
    res.status(500).json({ error: 'Failed to add crop to wishlist' });
  }
});

// 4. REMOVE CROP FROM WISHLIST
router.delete('/:cropId', verifyToken, async (req, res) => {
  try {
    const [result] = await db.query(
      `DELETE FROM wishlists WHERE buyer_id = ? AND crop_id = ?`,
      [req.user.id, req.params.cropId]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Crop was not in your wishlist' });
    }

    res.json({ message: 'Crop removed from wishlist successfully' });
  } catch (err) {
    console.error('DELETE /api/wishlist error:', err.message);
    res.status(500).json({ error: 'Failed to remove from wishlist' });
  }
});

module.exports = router;
