const express = require('express');
const jwt = require('jsonwebtoken');
const db = require('../db');
const { createNotification } = require('./notifications');
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

// 1. CREATE ORDER (Buyer places order with inventory locking)
router.post('/', verifyToken, async (req, res) => {
  try {
    if (req.user.role !== 'buyer') {
      return res.status(403).json({ error: 'Only buyers can place orders' });
    }

    const crop_id = req.body.crop_id || req.body.cropId;
    const quantity = parseInt(req.body.quantity_ordered || req.body.quantity || req.body.quantity_kg, 10);

    if (!crop_id) {
      return res.status(400).json({ error: 'Crop ID is required' });
    }

    if (isNaN(quantity) || quantity <= 0) {
      return res.status(400).json({ error: 'Please enter a valid positive quantity' });
    }

    const connection = await db.getConnection();
    try {
      await connection.beginTransaction();

      // Lock crop record for update to prevent race conditions & negative inventory
      const [crops] = await connection.query(
        `SELECT id, farmer_id, crop_name, price_per_kg, quantity_available FROM crops WHERE id = ? FOR UPDATE`,
        [crop_id]
      );

      if (crops.length === 0) {
        await connection.rollback();
        return res.status(404).json({ error: 'Crop not found' });
      }

      const crop = crops[0];

      if (crop.quantity_available < quantity) {
        await connection.rollback();
        return res.status(400).json({ 
          error: `Insufficient stock available. Only ${crop.quantity_available} kg left in stock.` 
        });
      }

      const price = parseFloat(crop.price_per_kg) || 0;
      const total_price = (quantity * price).toFixed(2);

      // Decrement available stock
      await connection.query(
        `UPDATE crops SET quantity_available = quantity_available - ? WHERE id = ?`,
        [quantity, crop.id]
      );

      // Insert new order
      const [result] = await connection.query(
        `INSERT INTO orders (buyer_id, crop_id, quantity, total_price, status) VALUES (?, ?, ?, ?, 'pending')`,
        [req.user.id, crop.id, quantity, total_price]
      );

      const orderId = result.insertId;

      // Record in order status history timeline
      await connection.query(
        `INSERT INTO order_status_history (order_id, status, changed_by_user_id, actor_role, note) 
         VALUES (?, 'pending', ?, 'buyer', 'Order placed by buyer')`,
        [orderId, req.user.id]
      );

      await connection.commit();

      // Notify farmer
      await createNotification(
        crop.farmer_id,
        'New Order Received',
        `Buyer placed an order for ${quantity} kg of ${crop.crop_name} (Order #${orderId}).`,
        'farmer-dashboard.html',
        'order'
      );

      res.status(201).json({ message: 'Order placed successfully!', orderId });
    } catch (txErr) {
      await connection.rollback();
      throw txErr;
    } finally {
      connection.release();
    }
  } catch (err) {
    console.error("POST /api/orders Error:", err.message);
    res.status(500).json({ error: 'Failed to place order: ' + err.message });
  }
});

// 2. FARMER STATS (Real aggregated statistics from DB)
router.get('/stats/farmer/:id', verifyToken, async (req, res) => {
  try {
    const [[row]] = await db.query(
      `SELECT COUNT(*) AS totalOrders,
              SUM(CASE WHEN orders.status = 'pending' THEN 1 ELSE 0 END) AS pendingOrders,
              SUM(CASE WHEN orders.status = 'accepted' THEN 1 ELSE 0 END) AS acceptedOrders,
              SUM(CASE WHEN orders.status = 'delivered' THEN 1 ELSE 0 END) AS deliveredOrders,
              COALESCE(SUM(CASE WHEN orders.status = 'delivered' THEN orders.quantity ELSE 0 END), 0) AS totalKgSold,
              COALESCE(SUM(CASE WHEN orders.status = 'delivered' THEN orders.total_price ELSE 0 END), 0) AS revenue
       FROM orders 
       JOIN crops ON orders.crop_id = crops.id
       WHERE crops.farmer_id = ?`,
      [req.params.id]
    );
    res.json(row || { totalOrders: 0, pendingOrders: 0, acceptedOrders: 0, deliveredOrders: 0, totalKgSold: 0, revenue: 0 });
  } catch (err) {
    console.error("GET /stats/farmer Error:", err.message);
    res.status(500).json({ error: 'Server error fetching stats' });
  }
});

// 3. GET BUYER ORDERS (Includes aliased fields for zero front-end discrepancies)
router.get('/buyer/:id', verifyToken, async (req, res) => {
  try {
    const [orders] = await db.query(
      `SELECT orders.*, 
              orders.quantity AS quantity_ordered,
              crops.crop_name, 
              crops.price_per_kg,
              crops.price_per_kg AS price, 
              crops.farmer_id, 
              crops.image,
              users.name AS farmer_name,
              users.location AS farmer_location
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
              orders.quantity AS quantity_ordered,
              crops.crop_name, 
              crops.price_per_kg,
              crops.price_per_kg AS price,
              users.name AS buyer_name, 
              users.location AS buyer_location,
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

// 5. GET ORDER TIMELINE & STATUS HISTORY
router.get('/:id/timeline', verifyToken, async (req, res) => {
  try {
    const [orders] = await db.query(
      `SELECT orders.*, crops.farmer_id, crops.crop_name 
       FROM orders 
       JOIN crops ON orders.crop_id = crops.id 
       WHERE orders.id = ?`,
      [req.params.id]
    );

    if (orders.length === 0) return res.status(404).json({ error: 'Order not found' });
    const order = orders[0];

    // Access check: only participating buyer or farmer can view
    if (req.user.id !== order.buyer_id && req.user.id !== order.farmer_id) {
      return res.status(403).json({ error: 'Not authorized to view this order timeline' });
    }

    const [history] = await db.query(
      `SELECT * FROM order_status_history WHERE order_id = ? ORDER BY created_at ASC`,
      [order.id]
    );

    res.json({ order, timeline: history });
  } catch (err) {
    console.error("GET /orders/:id/timeline error:", err.message);
    res.status(500).json({ error: 'Failed to fetch order timeline' });
  }
});

// 6. UPDATE ORDER STATUS (Validates lifecycle & restores inventory if cancelled/rejected)
router.put('/:id/status', verifyToken, async (req, res) => {
  const { status, note } = req.body;
  const validStatuses = ['pending', 'accepted', 'processing', 'shipped', 'delivered', 'cancelled', 'rejected'];

  if (!validStatuses.includes(status)) {
    return res.status(400).json({ error: 'Invalid status provided' });
  }

  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();

    const [orders] = await connection.query(
      `SELECT orders.*, crops.farmer_id, crops.crop_name 
       FROM orders 
       JOIN crops ON orders.crop_id = crops.id 
       WHERE orders.id = ? FOR UPDATE`,
      [req.params.id]
    );

    if (orders.length === 0) {
      await connection.rollback();
      return res.status(404).json({ error: 'Order not found' });
    }

    const order = orders[0];

    // Authorization & lifecycle transition rules
    if (req.user.role === 'buyer') {
      if (order.buyer_id !== req.user.id) {
        await connection.rollback();
        return res.status(403).json({ error: 'Not authorized for this order' });
      }
      if (status !== 'cancelled') {
        await connection.rollback();
        return res.status(403).json({ error: 'Buyers can only cancel pending orders' });
      }
      if (order.status !== 'pending') {
        await connection.rollback();
        return res.status(400).json({ error: `Cannot cancel order with status '${order.status}'` });
      }
    } else if (req.user.role === 'farmer') {
      if (order.farmer_id !== req.user.id) {
        await connection.rollback();
        return res.status(403).json({ error: 'Not authorized for this order' });
      }
      // Farmers can transition between logical fulfillment stages
      const allowedFarmerTransitions = {
        'pending': ['accepted', 'rejected'],
        'accepted': ['processing', 'cancelled'],
        'processing': ['shipped', 'cancelled'],
        'shipped': ['delivered'],
        'delivered': [],
        'cancelled': [],
        'rejected': []
      };

      const allowedNext = allowedFarmerTransitions[order.status] || [];
      if (!allowedNext.includes(status)) {
        await connection.rollback();
        return res.status(400).json({ 
          error: `Cannot transition order status from '${order.status}' to '${status}'` 
        });
      }
    }

    // If order was cancelled or rejected, restore crop stock!
    if (['cancelled', 'rejected'].includes(status) && !['cancelled', 'rejected'].includes(order.status)) {
      await connection.query(
        `UPDATE crops SET quantity_available = quantity_available + ? WHERE id = ?`,
        [order.quantity, order.crop_id]
      );
    }

    // Update order status
    await connection.query('UPDATE orders SET status = ? WHERE id = ?', [status, order.id]);

    // Record in history timeline
    await connection.query(
      `INSERT INTO order_status_history (order_id, status, changed_by_user_id, actor_role, note) 
       VALUES (?, ?, ?, ?, ?)`,
      [order.id, status, req.user.id, req.user.role, note || `Status updated to ${status}`]
    );

    await connection.commit();

    // Send notification to recipient
    const recipientId = req.user.role === 'farmer' ? order.buyer_id : order.farmer_id;
    const readableStatus = status.charAt(0).toUpperCase() + status.slice(1);
    await createNotification(
      recipientId,
      `Order Status: ${readableStatus}`,
      `Order #${order.id} for ${order.quantity} kg of ${order.crop_name} is now ${readableStatus}.`,
      req.user.role === 'farmer' ? 'buyer-dashboard.html' : 'farmer-dashboard.html',
      'order'
    );

    res.json({ message: 'Order status updated successfully', newStatus: status });
  } catch (err) {
    await connection.rollback();
    console.error("PUT /orders/status Error:", err.message);
    res.status(500).json({ error: 'Server error updating order status: ' + err.message });
  } finally {
    connection.release();
  }
});

module.exports = router;