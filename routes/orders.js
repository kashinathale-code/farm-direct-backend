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

// 1. CREATE ORDER (Buyer places order with tiered bulk discount & inventory locking)
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
        `SELECT id, farmer_id, crop_name, price_per_kg, quantity_available, bulk_pricing FROM crops WHERE id = ? FOR UPDATE`,
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

      const basePrice = parseFloat(crop.price_per_kg) || 0;
      let effectiveUnitPrice = basePrice;
      let appliedTierDiscount = 0;

      // Check tiered bulk pricing
      if (crop.bulk_pricing) {
        try {
          const tiers = typeof crop.bulk_pricing === 'string' ? JSON.parse(crop.bulk_pricing) : crop.bulk_pricing;
          if (Array.isArray(tiers) && tiers.length > 0) {
            // Find tier that matches quantity: min_qty <= quantity and (max_qty is null or quantity <= max_qty)
            const matchingTier = tiers
              .filter(t => quantity >= Number(t.min_qty) && (t.max_qty == null || quantity <= Number(t.max_qty)))
              .sort((a, b) => Number(a.price_per_kg) - Number(b.price_per_kg))[0]; // lowest price tier if multiple match

            if (matchingTier && Number(matchingTier.price_per_kg) < basePrice) {
              effectiveUnitPrice = Number(matchingTier.price_per_kg);
              appliedTierDiscount = Number(((basePrice - effectiveUnitPrice) * quantity).toFixed(2));
            }
          }
        } catch (e) {
          console.warn('Bulk tier parse error:', e.message);
        }
      }

      const total_price = (quantity * effectiveUnitPrice).toFixed(2);

      // Decrement available stock
      await connection.query(
        `UPDATE crops SET quantity_available = quantity_available - ? WHERE id = ?`,
        [quantity, crop.id]
      );

      // Insert new order with unit_price and applied_tier_discount
      const [result] = await connection.query(
        `INSERT INTO orders (buyer_id, crop_id, quantity, total_price, unit_price, applied_tier_discount, status) 
         VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
        [req.user.id, crop.id, quantity, total_price, effectiveUnitPrice, appliedTierDiscount]
      );

      const orderId = result.insertId;

      // Record in order status history timeline
      await connection.query(
        `INSERT INTO order_status_history (order_id, status, changed_by_user_id, actor_role, note) 
         VALUES (?, 'pending', ?, 'buyer', ?)`,
        [orderId, req.user.id, appliedTierDiscount > 0 ? `Order placed with bulk discount: ₹${appliedTierDiscount} saved!` : 'Order placed by buyer']
      );

      await connection.commit();

      // Notify farmer
      await createNotification(
        crop.farmer_id,
        'New Order Received',
        `Buyer placed an order for ${quantity} kg of ${crop.crop_name} (Order #${orderId}) for ₹${total_price}.`,
        'farmer-dashboard.html',
        'order'
      );

      res.status(201).json({
        message: 'Order placed successfully!',
        orderId,
        unit_price: effectiveUnitPrice,
        applied_tier_discount: appliedTierDiscount,
        total_price
      });
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

// 2. FARMER STATS
router.get('/stats/farmer/:id', verifyToken, async (req, res) => {
  try {
    const [[row]] = await db.query(
      `SELECT COUNT(*) AS totalOrders,
              SUM(CASE WHEN orders.status = 'pending' THEN 1 ELSE 0 END) AS pendingOrders,
              SUM(CASE WHEN orders.status IN ('accepted', 'confirmed', 'packed', 'processing', 'shipped', 'in_transit', 'out_for_delivery') THEN 1 ELSE 0 END) AS acceptedOrders,
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

// 3. GET BUYER ORDERS
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
              crops.traceability_code,
              crops.batch_id,
              users.name AS farmer_name,
              users.location AS farmer_location,
              users.district AS farmer_district,
              users.is_verified AS farmer_is_verified
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
              crops.traceability_code,
              crops.batch_id,
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
      `SELECT orders.*, crops.farmer_id, crops.crop_name, crops.traceability_code, crops.batch_id 
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

// 6. UPDATE ORDER STATUS (Supports standard 7-stage order lifecycle)
router.put('/:id/status', verifyToken, async (req, res) => {
  const { status, note } = req.body;
  
  // Normalize status synonyms
  let targetStatus = (status || '').toLowerCase().trim();
  if (targetStatus === 'confirmed') targetStatus = 'accepted';
  if (targetStatus === 'packed') targetStatus = 'processing';
  if (targetStatus === 'in_transit') targetStatus = 'shipped';

  const validStatuses = ['pending', 'accepted', 'processing', 'shipped', 'out_for_delivery', 'delivered', 'cancelled', 'rejected'];

  if (!validStatuses.includes(targetStatus)) {
    return res.status(400).json({ error: `Invalid status '${status}' provided` });
  }

  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();

    const [orders] = await connection.query(
      `SELECT orders.*, crops.farmer_id, crops.crop_name, crops.id AS crop_table_id 
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
      if (targetStatus !== 'cancelled') {
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
      
      const allowedFarmerTransitions = {
        'pending': ['accepted', 'rejected', 'cancelled'],
        'accepted': ['processing', 'shipped', 'cancelled'],
        'processing': ['shipped', 'out_for_delivery', 'cancelled'],
        'shipped': ['out_for_delivery', 'delivered'],
        'out_for_delivery': ['delivered'],
        'delivered': [],
        'cancelled': [],
        'rejected': []
      };

      const allowedNext = allowedFarmerTransitions[order.status] || [];
      if (!allowedNext.includes(targetStatus)) {
        await connection.rollback();
        return res.status(400).json({ 
          error: `Cannot transition order status from '${order.status}' to '${targetStatus}'` 
        });
      }
    }

    // If order was cancelled or rejected, restore crop stock!
    if (['cancelled', 'rejected'].includes(targetStatus) && !['cancelled', 'rejected'].includes(order.status)) {
      await connection.query(
        `UPDATE crops SET quantity_available = quantity_available + ? WHERE id = ?`,
        [order.quantity, order.crop_id]
      );
    }

    // Update order status
    await connection.query('UPDATE orders SET status = ? WHERE id = ?', [targetStatus, order.id]);

    // Record in history timeline
    await connection.query(
      `INSERT INTO order_status_history (order_id, status, changed_by_user_id, actor_role, note) 
       VALUES (?, ?, ?, ?, ?)`,
      [order.id, targetStatus, req.user.id, req.user.role, note || `Status updated to ${targetStatus}`]
    );

    // Record supply chain milestone in traceability_events
    try {
      const stageMap = {
        'accepted': 'Order Confirmed',
        'processing': 'Produce Packed & Graded',
        'shipped': 'Dispatched in Transit',
        'out_for_delivery': 'Out for Final Delivery',
        'delivered': 'Delivered to Buyer'
      };
      if (stageMap[targetStatus]) {
        await connection.query(
          `INSERT INTO traceability_events (crop_id, order_id, event_type, stage_name, description, performed_by)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [order.crop_table_id, order.id, targetStatus, stageMap[targetStatus], note || `Milestone reached: ${stageMap[targetStatus]} for Order #${order.id}`, req.user.role === 'farmer' ? 'Farmer Fulfillment' : 'Buyer']
        );
      }
    } catch (traceErr) {
      console.warn('Order traceability event note:', traceErr.message);
    }

    await connection.commit();

    // Send notification to recipient
    const recipientId = req.user.role === 'farmer' ? order.buyer_id : order.farmer_id;
    const readableStatus = targetStatus.charAt(0).toUpperCase() + targetStatus.slice(1);
    await createNotification(
      recipientId,
      `Order Status: ${readableStatus}`,
      `Order #${order.id} for ${order.quantity} kg of ${order.crop_name} is now ${readableStatus}.`,
      req.user.role === 'farmer' ? 'buyer-dashboard.html' : 'farmer-dashboard.html',
      'order'
    );

    res.json({ message: 'Order status updated successfully', newStatus: targetStatus });
  } catch (err) {
    await connection.rollback();
    console.error("PUT /orders/status Error:", err.message);
    res.status(500).json({ error: 'Server error updating order status: ' + err.message });
  } finally {
    connection.release();
  }
});

module.exports = router;
