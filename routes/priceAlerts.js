const express = require('express');
const jwt = require('jsonwebtoken');
const db = require('../db');
const { createNotification } = require('./notifications');
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

// 1. GET ALL PRICE ALERTS FOR BUYER
router.get('/', verifyToken, async (req, res) => {
  try {
    const [alerts] = await db.query(
      `SELECT * FROM price_alerts WHERE buyer_id = ? ORDER BY created_at DESC`,
      [req.user.id]
    );
    res.json(alerts);
  } catch (err) {
    console.error('GET /api/price-alerts error:', err.message);
    res.status(500).json({ error: 'Failed to fetch price alerts' });
  }
});

// 2. CREATE A PRICE ALERT
router.post('/', verifyToken, async (req, res) => {
  try {
    const { crop_name, target_price, district } = req.body;
    if (!crop_name || !target_price) {
      return res.status(400).json({ error: 'Crop name and target price per kg are required' });
    }

    const price = parseFloat(target_price);
    if (isNaN(price) || price <= 0) {
      return res.status(400).json({ error: 'Valid target price must be greater than zero' });
    }

    const [result] = await db.query(
      `INSERT INTO price_alerts (buyer_id, crop_name, target_price, district, is_active) 
       VALUES (?, ?, ?, ?, TRUE)`,
      [req.user.id, crop_name.trim(), price, district ? district.trim() : null]
    );

    res.status(201).json({
      message: `Price alert set for ${crop_name} at ₹${price}/kg or lower`,
      alert_id: result.insertId
    });
  } catch (err) {
    console.error('POST /api/price-alerts error:', err.message);
    res.status(500).json({ error: 'Failed to set price alert' });
  }
});

// 3. DELETE A PRICE ALERT
router.delete('/:id', verifyToken, async (req, res) => {
  try {
    const [result] = await db.query(
      `DELETE FROM price_alerts WHERE id = ? AND buyer_id = ?`,
      [req.params.id, req.user.id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Price alert not found' });
    }

    res.json({ message: 'Price alert removed successfully' });
  } catch (err) {
    console.error('DELETE /api/price-alerts error:', err.message);
    res.status(500).json({ error: 'Failed to delete price alert' });
  }
});

// Helper function to check and notify buyers when a crop listing meets their target price
async function checkAndTriggerPriceAlerts(cropName, pricePerKg, district, cropId) {
  try {
    if (!cropName || !pricePerKg) return;

    // Find active alerts matching crop name where price is <= target price
    const [matchingAlerts] = await db.query(
      `SELECT * FROM price_alerts 
       WHERE LOWER(TRIM(crop_name)) = LOWER(TRIM(?))
         AND target_price >= ?
         AND is_active = TRUE
         AND (district IS NULL OR ? IS NULL OR LOWER(district) = LOWER(?))`,
      [cropName, pricePerKg, district, district]
    );

    for (const alert of matchingAlerts) {
      await createNotification(
        alert.buyer_id,
        'Price Alert Triggered! 🎯',
        `A farmer listed ${cropName} for ₹${pricePerKg}/kg (your target: ₹${alert.target_price}/kg). Check it out now!`,
        'buyer-dashboard.html',
        'alert'
      );

      // Record trigger timestamp
      await db.query(
        `UPDATE price_alerts SET is_triggered = TRUE, last_notified_at = NOW() WHERE id = ?`,
        [alert.id]
      );
    }
  } catch (err) {
    console.error('checkAndTriggerPriceAlerts error:', err.message);
  }
}

module.exports = {
  router,
  checkAndTriggerPriceAlerts
};
