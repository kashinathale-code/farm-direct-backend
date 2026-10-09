const express = require('express');
const jwt = require('jsonwebtoken');
const db = require('../db');
require('dotenv').config();

const router = express.Router();

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

// GET ALL CROPS (Marketplace view)
router.get('/', async (req, res) => {
  try {
    const [crops] = await db.query(
      `SELECT 
         crops.id, 
         crops.farmer_id, 
         crops.crop_name, 
         crops.price_per_kg, 
         crops.quantity_available, 
         crops.description,
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

// GET CROPS BY FARMER ID
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

// POST NEW CROP
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

    if (!crop_name || !price_per_kg) {
      return res.status(400).json({ error: 'Crop name and price are required' });
    }

    const [result] = await db.query(
      'INSERT INTO crops (farmer_id, crop_name, price_per_kg, quantity_available, description) VALUES (?, ?, ?, ?, ?)',
      [req.user.id, crop_name, price_per_kg, quantity_available, description]
    );

    res.status(201).json({ message: 'Crop added successfully', cropId: result.insertId });
  } catch (err) {
    console.error("POST /api/crops Error:", err);
    res.status(500).json({ error: 'Server error while adding crop' });
  }
});

// UPDATE CROP
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

    await db.query(
      'UPDATE crops SET crop_name = ?, price_per_kg = ?, quantity_available = ?, description = ? WHERE id = ?',
      [crop_name, price_per_kg, quantity_available, description, req.params.id]
    );

    res.json({ message: 'Crop updated successfully' });
  } catch (err) {
    console.error("PUT /api/crops Error:", err);
    res.status(500).json({ error: 'Server error while updating crop' });
  }
});

// DELETE CROP
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