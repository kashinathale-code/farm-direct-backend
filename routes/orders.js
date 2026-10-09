const express = require('express');
const jwt = require('jsonwebtoken');
const db = require('../db');
require('dotenv').config();

const router = express.Router();

// Middleware to verify JWT Token
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

// 1. CREATE ORDER (Buyer)
router.post('/', verifyToken, async (req, res) => {
  try {
    if (req.user.role !== 'buyer') {
      return res.status(403).json({ error: 'Only buyers can place orders' });
    }

    const crop_id = req.body.crop_id || req.body.cropId;
    const quantity = Number(req.body.quantity_ordered || req.body.quantity || req.body.quantity_kg || 1);

    if (!crop_id) {
      return res.status(400).json({ error: 'Crop ID is required' });
    }

    // Fetch farmer_id and price directly from the crops table using the correct column name
    const [crops] = await db.query('SELECT farmer_id, price_per_kg FROM crops WHERE id = ?', [crop_id]);
    if (crops.length === 0) {
      return res.status(404).json({ error: 'Crop not found' });
    }

    const farmer_id = crops[0].farmer_id;
    const price = crops[0].price_per_kg || 0;
    const total_price = quantity * price;

    // Insert order matching the schema we defined in init-db.js
    const [result] = await db.query(
      'INSERT INTO orders (buyer_id, crop_id, quantity, total_price, status) VALUES (?, ?, ?, ?, "pending")',
      [req.user.id, crop_id, quantity, total_price]
    );

    res.status(201).json({ message: 'Order placed successfully!', orderId: result.insertId });
  } catch (err) {
    console.error("POST /api/orders Error:", err.message);
    res.status(500).json({ error: 'Failed to place order: ' + err.message });
  }
});

// 2. FARMER STATS
router.get('/stats/farmer/:id', verifyToken, async (req, res) => {
  try {
    const [[row]] = await db.query(
      `SELECT COUNT(*) AS totalOrders,
              SUM(CASE WHEN orders.status = 'pending' THEN 1 ELSE 0 END) AS pendingOrders,
              COALESCE(SUM(CASE WHEN orders.status = 'delivered' THEN orders.quantity * crops.price_per_kg ELSE 0 END),0) AS revenue
       FROM orders 
       JOIN crops ON orders.crop_id = crops.id
       WHERE crops.farmer_id = ?`,
      [req.params.id]
    );
    res.json(row || { totalOrders: 0, pendingOrders: 0, revenue: 0 });
  } catch (err) {
    console.error("GET /stats/farmer Error:", err.message);
    res.status(500).json({ error: 'Server error fetching stats' });
  }
});

// 3. GET BUYER ORDERS
router.get('/buyer/:id', verifyToken, async (req, res) => {
  try {
    const [orders] = await db.query(
      `SELECT orders.*, 
              crops.crop_name, 
              crops.price_per_kg AS price, 
              crops.farmer_id, 
              users.name AS farmer_name
       FROM orders 
       JOIN crops ON orders.crop_id = crops.id 
       JOIN users ON crops.farmer_id = users.id
       WHERE orders.buyer_id = ?
       ORDER BY orders.id DESC`,
      [req.params.id]
    );
    res.json(orders);
  } catch (err) {
    console.error("GET /buyer orders Error:", err.message);
    res.status(500).json({ error: 'Server error fetching buyer orders' });
  }
});

// 4. GET FARMER ORDERS
router.get('/farmer/:id', verifyToken, async (req, res) => {
  try {
    const [orders] = await db.query(
      `SELECT orders.*, 
              crops.crop_name, 
              users.name AS buyer_name, 
              orders.buyer_id
       FROM orders 
       JOIN crops ON orders.crop_id = crops.id 
       JOIN users ON orders.buyer_id = users.id
       WHERE crops.farmer_id = ?
       ORDER BY orders.id DESC`,
      [req.params.id]
    );
    res.json(orders);
  } catch (err) {
    console.error("GET /farmer orders Error:", err.message);
    res.status(500).json({ error: 'Server error fetching farmer orders' });
  }
});

// 5. UPDATE ORDER STATUS
router.put('/:id/status', verifyToken, async (req, res) => {
  try {
    const { status } = req.body;
    const [[order]] = await db.query(
      `SELECT orders.*, crops.farmer_id 
       FROM orders JOIN crops ON orders.crop_id = crops.id 
       WHERE orders.id = ?`,
      [req.params.id]
    );
    if (!order) return res.status(404).json({ error: 'Order not found' });

    if (req.user.role === 'buyer') {
      if (order.buyer_id !== req.user.id) return res.status(403).json({ error: 'Not your order' });
      if (status !== 'cancelled') return res.status(403).json({ error: 'Buyers can only cancel orders' });
      if (order.status !== 'pending') return res.status(400).json({ error: 'Only pending orders can be cancelled' });
    } else if (req.user.role === 'farmer') {
      if (order.farmer_id !== req.user.id) return res.status(403).json({ error: 'Not your crop' });
      if (!['pending', 'accepted', 'delivered'].includes(status)) {
        return res.status(400).json({ error: 'Invalid status' });
      }
    }

    await db.query('UPDATE orders SET status = ? WHERE id = ?', [status, req.params.id]);
    res.json({ message: 'Order status updated' });
  } catch (err) {
    console.error("PUT /orders/status Error:", err.message);
    res.status(500).json({ error: 'Server error updating order status' });
  }
});

module.exports = router;