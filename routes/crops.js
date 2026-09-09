const express = require('express');
const jwt = require('jsonwebtoken');
const db = require('../db');
require('dotenv').config();

const router = express.Router();

function verifyToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token provided' });
  jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
    if (err) return res.status(403).json({ error: 'Invalid or expired token' });
    req.user = decoded;
    next();
  });
}

router.get('/', async (req, res) => {
  try {
    const [crops] = await db.query(
      `SELECT crops.*, users.name AS farmer_name, users.location 
       FROM crops JOIN users ON crops.farmer_id = users.id`
    );
    res.json(crops);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

router.get('/stats/farmer/:id', verifyToken, async (req, res) => {
  try {
    const [[row]] = await db.query(
      `SELECT COUNT(*) AS totalCrops,
              COALESCE(SUM(quantity),0) AS totalStock,
              SUM(CASE WHEN quantity < 5 THEN 1 ELSE 0 END) AS lowStockCount
       FROM crops WHERE farmer_id = ?`,
      [req.params.id]
    );
    res.json(row);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

router.get('/farmer/:id', verifyToken, async (req, res) => {
  try {
    const [crops] = await db.query('SELECT * FROM crops WHERE farmer_id = ?', [req.params.id]);
    res.json(crops);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/', verifyToken, async (req, res) => {
  try {
    if (req.user.role !== 'farmer') {
      return res.status(403).json({ error: 'Only farmers can add crops' });
    }
    const cropName = req.body.name || req.body.crop_name;
    const price = req.body.price || req.body.price_per_kg;
    const quantity = req.body.quantity || req.body.quantity_available;
    const description = req.body.description || '';

    const [result] = await db.query(
      'INSERT INTO crops (farmer_id, name, price, quantity, description) VALUES (?, ?, ?, ?, ?)',
      [req.user.id, cropName, price, quantity, description]
    );
    res.status(201).json({ message: 'Crop added successfully', cropId: result.insertId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

router.put('/:id', verifyToken, async (req, res) => {
  try {
    const cropName = req.body.name || req.body.crop_name;
    const price = req.body.price || req.body.price_per_kg;
    const quantity = req.body.quantity || req.body.quantity_available;
    const description = req.body.description || '';

    const [result] = await db.query(
      'UPDATE crops SET name = ?, price = ?, quantity = ?, description = ? WHERE id = ? AND farmer_id = ?',
      [cropName, price, quantity, description, req.params.id, req.user.id]
    );
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Crop not found or not yours' });
    }
    res.json({ message: 'Crop updated successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

router.delete('/:id', verifyToken, async (req, res) => {
  try {
    if (req.user.role !== 'farmer') {
      return res.status(403).json({ error: 'Only farmers can delete crops' });
    }
    const [result] = await db.query(
      'DELETE FROM crops WHERE id = ? AND farmer_id = ?',
      [req.params.id, req.user.id]
    );
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Crop not found or not yours' });
    }
    res.json({ message: 'Crop deleted' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;