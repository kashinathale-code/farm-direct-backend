// ============================================================================
// FARM DIRECT — DELIVERY PARTNER & LIVE SHIPMENT TRACKING ROUTER
// ============================================================================

const express = require('express');
const db = require('../db');
const { verifyToken, requireRole, recordAuditLog } = require('../middleware/auth');
const { createNotification } = require('./notifications');

const router = express.Router();

// 1. GET ASSIGNED DELIVERIES FOR AUTHENTICATED DELIVERY PARTNER
router.get('/assigned', verifyToken, requireRole('delivery_partner', 'admin', 'super_admin'), async (req, res) => {
  try {
    const partnerId = req.user.id;
    const [deliveries] = await db.query(
      `SELECT 
         delivery_assignments.id AS assignment_id,
         delivery_assignments.order_id,
         delivery_assignments.status AS delivery_status,
         delivery_assignments.pickup_time,
         delivery_assignments.delivery_time,
         delivery_assignments.estimated_delivery,
         delivery_assignments.notes AS delivery_notes,
         orders.quantity,
         orders.total_price,
         orders.unit_price,
         orders.status AS order_status,
         crops.crop_name,
         crops.image AS crop_image,
         farmer.name AS farmer_name,
         farmer.phone AS farmer_phone,
         farmer.location AS farmer_pickup_location,
         farmer.district AS farmer_district,
         buyer.name AS buyer_name,
         buyer.phone AS buyer_phone,
         buyer.location AS buyer_delivery_address,
         buyer.district AS buyer_district
       FROM delivery_assignments
       JOIN orders ON delivery_assignments.order_id = orders.id
       JOIN crops ON orders.crop_id = crops.id
       JOIN users AS farmer ON crops.farmer_id = farmer.id
       JOIN users AS buyer ON orders.buyer_id = buyer.id
       WHERE delivery_assignments.delivery_partner_id = ?
       ORDER BY delivery_assignments.id DESC`,
      [partnerId]
    );

    res.json(deliveries);
  } catch (err) {
    console.error('GET /api/delivery/assigned error:', err.message);
    res.status(500).json({ error: 'Failed to fetch assigned deliveries' });
  }
});

// 2. GET LIVE DELIVERY TRACKING FOR AN ORDER (Buyer, Farmer, Delivery Partner, Admin)
router.get('/order/:orderId', verifyToken, async (req, res) => {
  try {
    const orderId = parseInt(req.params.orderId, 10);

    const [orders] = await db.query(
      `SELECT orders.*, crops.farmer_id, crops.crop_name, crops.traceability_code, crops.batch_id,
              farmer.name AS farmer_name, farmer.district AS farmer_district, farmer.location AS farmer_pickup_location,
              buyer.name AS buyer_name, buyer.district AS buyer_district, buyer.location AS buyer_delivery_address
       FROM orders
       JOIN crops ON orders.crop_id = crops.id
       JOIN users AS farmer ON crops.farmer_id = farmer.id
       JOIN users AS buyer ON orders.buyer_id = buyer.id
       WHERE orders.id = ?`,
      [orderId]
    );

    if (orders.length === 0) return res.status(404).json({ error: 'Order not found' });
    const order = orders[0];

    // Access check: only buyer, farmer, assigned delivery partner, or admin can track
    const [assignments] = await db.query(
      `SELECT delivery_assignments.*, 
              users.name AS partner_name, users.phone AS partner_phone,
              delivery_partner_profiles.vehicle_type, delivery_partner_profiles.vehicle_number,
              delivery_partner_profiles.is_sharing_location, delivery_partner_profiles.last_location_update,
              delivery_partner_profiles.current_latitude, delivery_partner_profiles.current_longitude
       FROM delivery_assignments
       JOIN users ON delivery_assignments.delivery_partner_id = users.id
       LEFT JOIN delivery_partner_profiles ON users.id = delivery_partner_profiles.user_id
       WHERE delivery_assignments.order_id = ?`,
      [orderId]
    );

    const assignment = assignments.length > 0 ? assignments[0] : null;

    if (req.user.role === 'buyer' && req.user.id !== order.buyer_id) {
      return res.status(403).json({ error: 'Not authorized to view tracking for this order' });
    }
    if (req.user.role === 'farmer' && req.user.id !== order.farmer_id) {
      return res.status(403).json({ error: 'Not authorized to view tracking for this order' });
    }
    if (req.user.role === 'delivery_partner' && (!assignment || req.user.id !== assignment.delivery_partner_id)) {
      return res.status(403).json({ error: 'Not assigned to this delivery' });
    }

    // Get order status history timeline
    const [history] = await db.query(
      `SELECT * FROM order_status_history WHERE order_id = ? ORDER BY created_at ASC`,
      [orderId]
    );

    // Get latest location breadcrumbs if active
    let breadcrumbs = [];
    if (assignment) {
      const [crumbs] = await db.query(
        `SELECT latitude, longitude, heading, speed_kmh, recorded_at 
         FROM delivery_location_updates 
         WHERE delivery_assignment_id = ? 
         ORDER BY id DESC LIMIT 20`,
        [assignment.id]
      );
      breadcrumbs = crumbs;
    }

    // Get proof of delivery if available
    let proofs = [];
    if (assignment) {
      const [pRows] = await db.query(
        `SELECT proof_type, photo_url, recipient_name, notes, recorded_at 
         FROM delivery_proofs 
         WHERE delivery_assignment_id = ?`,
        [assignment.id]
      );
      proofs = pRows;
    }

    res.json({
      order: {
        id: order.id,
        crop_name: order.crop_name,
        quantity: order.quantity,
        total_price: order.total_price,
        order_status: order.status,
        batch_id: order.batch_id,
        traceability_code: order.traceability_code,
        pickup_location: order.farmer_pickup_location,
        delivery_address: order.buyer_delivery_address,
        farmer_name: order.farmer_name,
        farmer_district: order.farmer_district,
        buyer_name: order.buyer_name,
        buyer_district: order.buyer_district
      },
      assignment: assignment ? {
        id: assignment.id,
        status: assignment.status,
        partner_name: assignment.partner_name,
        partner_phone: assignment.partner_phone,
        vehicle_type: assignment.vehicle_type || 'Agri Cargo Vehicle',
        vehicle_number: assignment.vehicle_number || 'MH-12-AG-2026',
        is_sharing_location: assignment.is_sharing_location === 1 || assignment.is_sharing_location === true,
        current_location: assignment.is_sharing_location ? {
          latitude: assignment.current_latitude,
          longitude: assignment.current_longitude,
          last_updated: assignment.last_location_update
        } : null,
        pickup_time: assignment.pickup_time,
        delivery_time: assignment.delivery_time,
        estimated_delivery: assignment.estimated_delivery
      } : null,
      timeline: history,
      breadcrumbs,
      proofs
    });
  } catch (err) {
    console.error('GET /api/delivery/order/:id error:', err.message);
    res.status(500).json({ error: 'Failed to fetch delivery tracking' });
  }
});

// 3. ADMIN ASSIGN ORDER TO DELIVERY PARTNER
router.post('/assign', verifyToken, requireRole('admin', 'super_admin'), async (req, res) => {
  try {
    const { order_id, delivery_partner_id, estimated_delivery, notes } = req.body;
    if (!order_id || !delivery_partner_id) {
      return res.status(400).json({ error: 'order_id and delivery_partner_id are required' });
    }

    // Verify order exists
    const [orders] = await db.query(`SELECT * FROM orders WHERE id = ?`, [order_id]);
    if (orders.length === 0) return res.status(404).json({ error: 'Order not found' });
    const order = orders[0];

    // Verify delivery partner exists and has correct role
    const [partners] = await db.query(`SELECT * FROM users WHERE id = ? AND role = 'delivery_partner'`, [delivery_partner_id]);
    if (partners.length === 0) return res.status(400).json({ error: 'Valid delivery partner account not found' });
    const partner = partners[0];

    // Upsert assignment
    const [result] = await db.query(
      `INSERT INTO delivery_assignments 
        (order_id, delivery_partner_id, assigned_by, status, estimated_delivery, notes)
       VALUES (?, ?, ?, 'assigned', ?, ?)
       ON DUPLICATE KEY UPDATE 
         delivery_partner_id = VALUES(delivery_partner_id),
         assigned_by = VALUES(assigned_by),
         estimated_delivery = VALUES(estimated_delivery),
         notes = VALUES(notes),
         status = 'assigned'`,
      [order_id, delivery_partner_id, req.user.id, estimated_delivery || null, notes || '']
    );

    // Update order status to 'processing' (Ready for Pickup / Assigned) if it was accepted
    if (['accepted', 'confirmed'].includes(order.status)) {
      await db.query(`UPDATE orders SET status = 'processing' WHERE id = ?`, [order_id]);
      await db.query(
        `INSERT INTO order_status_history (order_id, status, changed_by_user_id, actor_role, note)
         VALUES (?, 'processing', ?, 'admin', ?)`,
        [order_id, req.user.id, `Assigned to delivery partner ${partner.name}`]
      );
    }

    // Notify delivery partner
    await createNotification(
      delivery_partner_id,
      'New Shipment Assigned',
      `Order #${order_id} has been assigned to you for pickup and delivery.`,
      'delivery-dashboard.html',
      'delivery'
    );

    // Notify buyer
    await createNotification(
      order.buyer_id,
      'Delivery Partner Assigned',
      `Delivery partner ${partner.name} has been assigned to your Order #${order_id}.`,
      'buyer-dashboard.html',
      'delivery'
    );

    await recordAuditLog(
      req.user.id,
      req.user.role,
      'ASSIGN_DELIVERY_PARTNER',
      'orders',
      order_id,
      { delivery_partner_id, partner_name: partner.name },
      req
    );

    res.status(201).json({ message: 'Delivery partner assigned successfully' });
  } catch (err) {
    console.error('POST /api/delivery/assign error:', err.message);
    res.status(500).json({ error: 'Failed to assign delivery partner' });
  }
});

// 4. DELIVERY PARTNER UPDATE SHIPMENT STATUS
router.put('/status', verifyToken, requireRole('delivery_partner', 'admin', 'super_admin'), async (req, res) => {
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();

    const { assignment_id, status, notes } = req.body;
    if (!assignment_id || !status) {
      await connection.rollback();
      return res.status(400).json({ error: 'assignment_id and status are required' });
    }

    const [assignments] = await connection.query(
      `SELECT delivery_assignments.*, orders.buyer_id, orders.crop_id, crops.farmer_id, crops.crop_name, crops.id AS crop_table_id 
       FROM delivery_assignments 
       JOIN orders ON delivery_assignments.order_id = orders.id 
       JOIN crops ON orders.crop_id = crops.id 
       WHERE delivery_assignments.id = ? FOR UPDATE`,
      [assignment_id]
    );

    if (assignments.length === 0) {
      await connection.rollback();
      return res.status(404).json({ error: 'Delivery assignment not found' });
    }

    const assignment = assignments[0];

    // Authorization: partner owns assignment or is admin
    if (req.user.role === 'delivery_partner' && assignment.delivery_partner_id !== req.user.id) {
      await connection.rollback();
      return res.status(403).json({ error: 'Not authorized for this shipment' });
    }

    // Map delivery status to order status
    let orderStatus = null;
    let pickupTime = assignment.pickup_time;
    let deliveryTime = assignment.delivery_time;

    if (status === 'picked_up') {
      orderStatus = 'shipped';
      pickupTime = new Date();
    } else if (status === 'in_transit') {
      orderStatus = 'shipped';
    } else if (status === 'out_for_delivery') {
      orderStatus = 'out_for_delivery';
    } else if (status === 'delivered') {
      orderStatus = 'delivered';
      deliveryTime = new Date();
    }

    // Update delivery assignment
    await connection.query(
      `UPDATE delivery_assignments 
       SET status = ?, pickup_time = COALESCE(?, pickup_time), delivery_time = COALESCE(?, delivery_time), notes = COALESCE(?, notes)
       WHERE id = ?`,
      [status, pickupTime, deliveryTime, notes || null, assignment.id]
    );

    // Update order status if mapped
    if (orderStatus) {
      await connection.query(`UPDATE orders SET status = ? WHERE id = ?`, [orderStatus, assignment.order_id]);
      
      // Add status history entry
      await connection.query(
        `INSERT INTO order_status_history (order_id, status, changed_by_user_id, actor_role, note)
         VALUES (?, ?, ?, ?, ?)`,
        [assignment.order_id, orderStatus, req.user.id, req.user.role, notes || `Shipment status: ${status}`]
      );

      // Add supply chain traceability milestone
      try {
        const stageDescMap = {
          'picked_up': 'Harvest picked up from farm by delivery partner',
          'in_transit': 'Dispatched and in transit on regional agricultural corridor',
          'out_for_delivery': 'Out for final delivery to buyer destination',
          'delivered': 'Successfully delivered and accepted by buyer'
        };
        await connection.query(
          `INSERT INTO traceability_events (crop_id, order_id, event_type, stage_name, description, performed_by)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [assignment.crop_table_id, assignment.order_id, status, status.toUpperCase(), stageDescMap[status] || status, req.user.name]
        );
      } catch (traceErr) {
        console.warn('Traceability insert note:', traceErr.message);
      }
    }

    // If delivered, stop location sharing automatically!
    if (status === 'delivered') {
      await connection.query(
        `UPDATE delivery_partner_profiles SET is_sharing_location = FALSE WHERE user_id = ?`,
        [assignment.delivery_partner_id]
      );
    }

    await connection.commit();

    // Notify buyer & farmer
    const readableStatus = status.replace(/_/g, ' ').toUpperCase();
    await createNotification(
      assignment.buyer_id,
      `Delivery Update: ${readableStatus}`,
      `Your shipment for Order #${assignment.order_id} is now ${readableStatus}.`,
      'buyer-dashboard.html',
      'delivery'
    );

    res.json({ message: 'Delivery status updated successfully', status, orderStatus });
  } catch (err) {
    await connection.rollback();
    console.error('PUT /api/delivery/status error:', err.message);
    res.status(500).json({ error: 'Failed to update delivery status: ' + err.message });
  } finally {
    connection.release();
  }
});

// 5. LIVE GPS LOCATION UPDATE (From Delivery Partner Browser Geolocation)
router.post('/location-update', verifyToken, requireRole('delivery_partner'), async (req, res) => {
  try {
    const { assignment_id, latitude, longitude, heading, speed_kmh } = req.body;
    if (!assignment_id || latitude == null || longitude == null) {
      return res.status(400).json({ error: 'assignment_id, latitude, and longitude are required' });
    }

    // Verify assignment belongs to partner
    const [assignments] = await db.query(
      `SELECT * FROM delivery_assignments WHERE id = ? AND delivery_partner_id = ?`,
      [assignment_id, req.user.id]
    );

    if (assignments.length === 0) {
      return res.status(403).json({ error: 'Not authorized for this assignment' });
    }

    // Only accept location updates if delivery is active
    if (!['assigned', 'picked_up', 'in_transit', 'out_for_delivery'].includes(assignments[0].status)) {
      return res.status(400).json({ error: 'Location tracking is only recorded for active deliveries' });
    }

    // 1. Record breadcrumb point
    await db.query(
      `INSERT INTO delivery_location_updates 
        (delivery_assignment_id, delivery_partner_id, latitude, longitude, heading, speed_kmh)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [assignment_id, req.user.id, latitude, longitude, heading || null, speed_kmh || null]
    );

    // 2. Update current position in delivery_partner_profiles
    await db.query(
      `INSERT INTO delivery_partner_profiles (user_id, current_latitude, current_longitude, is_sharing_location, last_location_update)
       VALUES (?, ?, ?, TRUE, CURRENT_TIMESTAMP)
       ON DUPLICATE KEY UPDATE
         current_latitude = VALUES(current_latitude),
         current_longitude = VALUES(current_longitude),
         is_sharing_location = TRUE,
         last_location_update = CURRENT_TIMESTAMP`,
      [req.user.id, latitude, longitude]
    );

    res.json({ status: 'ok', recorded_at: new Date().toISOString() });
  } catch (err) {
    console.error('POST /api/delivery/location-update error:', err.message);
    res.status(500).json({ error: 'Failed to record location update' });
  }
});

// 6. TOGGLE LOCATION SHARING (Start/Stop)
router.post('/toggle-location-sharing', verifyToken, requireRole('delivery_partner'), async (req, res) => {
  try {
    const { is_sharing } = req.body;
    const sharingBool = is_sharing === true || is_sharing === 'true';

    await db.query(
      `INSERT INTO delivery_partner_profiles (user_id, is_sharing_location)
       VALUES (?, ?)
       ON DUPLICATE KEY UPDATE is_sharing_location = ?`,
      [req.user.id, sharingBool, sharingBool]
    );

    res.json({ message: `Location sharing ${sharingBool ? 'activated' : 'deactivated'}`, is_sharing: sharingBool });
  } catch (err) {
    console.error('POST /api/delivery/toggle-location-sharing error:', err.message);
    res.status(500).json({ error: 'Failed to toggle location sharing' });
  }
});

// 7. SUBMIT PROOF OF PICKUP / DELIVERY
router.post('/proof', verifyToken, requireRole('delivery_partner'), async (req, res) => {
  try {
    const { assignment_id, proof_type, photo_url, recipient_name, notes, latitude, longitude } = req.body;
    if (!assignment_id || !proof_type) {
      return res.status(400).json({ error: 'assignment_id and proof_type (pickup/delivery) are required' });
    }

    const [assignments] = await db.query(
      `SELECT * FROM delivery_assignments WHERE id = ? AND delivery_partner_id = ?`,
      [assignment_id, req.user.id]
    );

    if (assignments.length === 0) {
      return res.status(403).json({ error: 'Not authorized for this assignment' });
    }

    const [result] = await db.query(
      `INSERT INTO delivery_proofs 
        (delivery_assignment_id, proof_type, photo_url, recipient_name, notes, latitude, longitude)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [assignment_id, proof_type, photo_url || null, recipient_name || null, notes || null, latitude || null, longitude || null]
    );

    res.status(201).json({ message: `Proof of ${proof_type} recorded successfully`, proof_id: result.insertId });
  } catch (err) {
    console.error('POST /api/delivery/proof error:', err.message);
    res.status(500).json({ error: 'Failed to save delivery proof' });
  }
});

// 8. ADMIN GET ALL DELIVERY PARTNERS
router.get('/partners', verifyToken, requireRole('admin', 'super_admin'), async (req, res) => {
  try {
    const [partners] = await db.query(
      `SELECT 
         users.id, users.name, users.email, users.phone, users.status, users.location,
         delivery_partner_profiles.vehicle_type,
         delivery_partner_profiles.vehicle_number,
         delivery_partner_profiles.operating_district,
         delivery_partner_profiles.is_available,
         delivery_partner_profiles.is_sharing_location,
         delivery_partner_profiles.last_location_update,
         COUNT(delivery_assignments.id) AS total_assignments,
         SUM(CASE WHEN delivery_assignments.status IN ('assigned', 'picked_up', 'in_transit', 'out_for_delivery') THEN 1 ELSE 0 END) AS active_assignments
       FROM users
       LEFT JOIN delivery_partner_profiles ON users.id = delivery_partner_profiles.user_id
       LEFT JOIN delivery_assignments ON users.id = delivery_assignments.delivery_partner_id
       WHERE users.role = 'delivery_partner'
       GROUP BY users.id
       ORDER BY users.id DESC`
    );

    res.json(partners);
  } catch (err) {
    console.error('GET /api/delivery/partners error:', err.message);
    res.status(500).json({ error: 'Failed to fetch delivery partners list' });
  }
});

module.exports = router;
