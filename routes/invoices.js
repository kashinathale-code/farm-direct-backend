// ============================================================================
// FARM DIRECT — AUTOMATIC PDF & PRINTABLE INVOICE GENERATOR ROUTER
// ============================================================================

const express = require('express');
const db = require('../db');
const { verifyToken, requireRole } = require('../middleware/auth');

const router = express.Router();

// Helper to generate unique sequential invoice number
function generateInvoiceNumber(orderId) {
  const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const paddedId = String(orderId).padStart(4, '0');
  return `INV-${dateStr}-${paddedId}`;
}

// 1. GET OR GENERATE INVOICE FOR AN ORDER
router.get('/order/:orderId', verifyToken, async (req, res) => {
  try {
    const orderId = parseInt(req.params.orderId, 10);

    // 1. Fetch order details
    const [orders] = await db.query(
      `SELECT orders.*, 
              crops.crop_name, crops.price_per_kg, crops.batch_id, crops.farmer_id,
              farmer.name AS farmer_name, farmer.email AS farmer_email, farmer.district AS farmer_district, farmer.location AS farmer_location, farmer.gstin AS farmer_gstin,
              buyer.name AS buyer_name, buyer.email AS buyer_email, buyer.phone AS buyer_phone, buyer.location AS buyer_address, buyer.district AS buyer_district, buyer.gstin AS buyer_gstin
       FROM orders
       JOIN crops ON orders.crop_id = crops.id
       JOIN users AS farmer ON crops.farmer_id = farmer.id
       JOIN users AS buyer ON orders.buyer_id = buyer.id
       WHERE orders.id = ?`,
      [orderId]
    );

    if (orders.length === 0) return res.status(404).json({ error: 'Order not found' });
    const order = orders[0];

    // Authorization: buyer, farmer, or admin
    if (req.user.role === 'buyer' && req.user.id !== order.buyer_id) {
      return res.status(403).json({ error: 'Not authorized to access this invoice' });
    }
    if (req.user.role === 'farmer' && req.user.id !== order.farmer_id) {
      return res.status(403).json({ error: 'Not authorized to access this invoice' });
    }

    // 2. Check if invoice already exists
    const [existing] = await db.query(`SELECT * FROM invoices WHERE order_id = ?`, [orderId]);
    if (existing.length > 0) {
      const inv = existing[0];
      const [items] = await db.query(`SELECT * FROM invoice_items WHERE invoice_id = ?`, [inv.id]);
      return res.json({ invoice: inv, items, order });
    }

    // 3. Generate new invoice
    const invNumber = generateInvoiceNumber(order.id);
    const subtotal = parseFloat(order.total_price);
    const deliveryCharges = 40.00; // Flat local agri transport fee
    const platformFee = parseFloat((subtotal * 0.02).toFixed(2)); // 2% platform trade facilitation
    const taxAmount = 0.00; // Fresh agricultural produce is 0% GST in India
    const totalAmount = parseFloat((subtotal + deliveryCharges + platformFee).toFixed(2));

    const [invResult] = await db.query(
      `INSERT INTO invoices 
        (invoice_number, order_id, buyer_id, farmer_id, subtotal, delivery_charges, platform_fee, tax_amount, total_amount, payment_method, payment_status, payment_ref)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'Direct Fair Trade / UPI', 'completed', ?)`,
      [invNumber, order.id, order.buyer_id, order.farmer_id, subtotal, deliveryCharges, platformFee, taxAmount, totalAmount, `TXN-${Date.now().toString(36).toUpperCase()}`]
    );

    const invoiceId = invResult.insertId;

    // Insert line item
    await db.query(
      `INSERT INTO invoice_items (invoice_id, crop_id, crop_name, quantity, unit_price, total_price)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [invoiceId, order.crop_id, order.crop_name, order.quantity, order.unit_price || order.price_per_kg, subtotal]
    );

    const [newInv] = await db.query(`SELECT * FROM invoices WHERE id = ?`, [invoiceId]);
    const [newItems] = await db.query(`SELECT * FROM invoice_items WHERE invoice_id = ?`, [invoiceId]);

    res.status(201).json({ invoice: newInv[0], items: newItems, order });
  } catch (err) {
    console.error('GET /api/invoices/order/:id error:', err.message);
    res.status(500).json({ error: 'Failed to generate invoice' });
  }
});

// 2. DOWNLOAD / VIEW PRINTABLE HTML INVOICE (Converts to PDF via Browser / Print)
router.get('/:id/print', verifyToken, async (req, res) => {
  try {
    const invoiceId = parseInt(req.params.id, 10);
    const [invoices] = await db.query(`SELECT * FROM invoices WHERE id = ?`, [invoiceId]);
    if (invoices.length === 0) return res.status(404).send('Invoice not found');
    const invoice = invoices[0];

    // Authorization
    if (req.user.role === 'buyer' && req.user.id !== invoice.buyer_id) {
      return res.status(403).send('Not authorized');
    }
    if (req.user.role === 'farmer' && req.user.id !== invoice.farmer_id) {
      return res.status(403).send('Not authorized');
    }

    const [items] = await db.query(`SELECT * FROM invoice_items WHERE invoice_id = ?`, [invoiceId]);
    const [orders] = await db.query(
      `SELECT orders.*, farmer.name AS farmer_name, farmer.district AS farmer_district, farmer.location AS farmer_location,
              buyer.name AS buyer_name, buyer.district AS buyer_district, buyer.location AS buyer_location, buyer.phone AS buyer_phone
       FROM orders
       JOIN users AS farmer ON orders.crop_id = orders.crop_id
       JOIN users AS buyer ON orders.buyer_id = buyer.id
       WHERE orders.id = ? LIMIT 1`,
      [invoice.order_id]
    );
    const order = orders[0] || {};

    const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Invoice #${invoice.invoice_number} — Farm Direct</title>
  <style>
    body { font-family: 'Segoe UI', Arial, sans-serif; margin: 40px; color: #1F2937; background: #fff; }
    .inv-header { display: flex; justify-content: space-between; border-bottom: 2px solid #143D2B; padding-bottom: 20px; }
    .brand-title { font-size: 24px; font-weight: 800; color: #143D2B; }
    .brand-tag { font-size: 12px; color: #6B7280; text-transform: uppercase; }
    .inv-meta { text-align: right; }
    .inv-number { font-size: 20px; font-weight: 700; color: #2E7D32; }
    .grid-2 { display: flex; justify-content: space-between; margin: 30px 0; gap: 40px; }
    .col { flex: 1; background: #F7F9F6; padding: 18px; border-radius: 8px; font-size: 13.5px; }
    .col h4 { margin: 0 0 10px; color: #143D2B; font-size: 14px; text-transform: uppercase; }
    table { width: 100%; border-collapse: collapse; margin: 24px 0; font-size: 14px; }
    th { background: #143D2B; color: #fff; text-align: left; padding: 12px; }
    td { padding: 12px; border-bottom: 1px solid #E2E8F0; }
    .totals { width: 320px; margin-left: auto; margin-top: 20px; }
    .tot-row { display: flex; justify-content: space-between; padding: 6px 0; font-size: 13.5px; }
    .tot-row.grand { font-size: 18px; font-weight: 800; color: #143D2B; border-top: 2px solid #143D2B; padding-top: 10px; margin-top: 10px; }
    .badge { display: inline-block; padding: 4px 10px; border-radius: 999px; font-size: 11px; font-weight: 700; background: #DEF7EC; color: #03543F; }
    .print-btn { background: #2E7D32; color: #fff; border: none; padding: 10px 20px; border-radius: 6px; cursor: pointer; font-weight: 600; font-size: 14px; margin-bottom: 20px; }
    @media print { .print-btn { display: none; } body { margin: 0; } }
  </style>
</head>
<body>
  <button class="print-btn" onclick="window.print()">🖨️ Print / Save as PDF</button>

  <div class="inv-header">
    <div>
      <div class="brand-title">🌱 Farm Direct</div>
      <div class="brand-tag">Direct-to-Consumer Agricultural Marketplace</div>
      <p style="margin: 6px 0 0; font-size: 12px; color: #6B7280;">Fair Agricultural Trade Network · India</p>
    </div>
    <div class="inv-meta">
      <div class="inv-number">${invoice.invoice_number}</div>
      <div style="font-size: 13px; color: #6B7280; margin-top: 4px;">Date: ${new Date(invoice.invoice_date).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}</div>
      <div style="margin-top: 6px;"><span class="badge">✓ Payment Completed</span></div>
    </div>
  </div>

  <div class="grid-2">
    <div class="col">
      <h4>Billed From (Farmer / Seller)</h4>
      <strong>${order.farmer_name || 'Farmer Seller'}</strong><br>
      Location: ${order.farmer_location || order.farmer_district || 'Maharashtra, India'}<br>
      Agricultural Produce Trade (Direct Farmer Corridors)
    </div>
    <div class="col">
      <h4>Billed To (Buyer)</h4>
      <strong>${order.buyer_name || 'Buyer'}</strong><br>
      Delivery Address: ${order.buyer_location || order.buyer_district || 'Delivery Destination'}<br>
      Phone: ${order.buyer_phone || 'Registered on Farm Direct'}<br>
      Order Reference: #${invoice.order_id}
    </div>
  </div>

  <table>
    <thead>
      <tr>
        <th>Produce Item</th>
        <th style="text-align:center;">Quantity (kg)</th>
        <th style="text-align:right;">Unit Price (₹/kg)</th>
        <th style="text-align:right;">Total Amount (₹)</th>
      </tr>
    </thead>
    <tbody>
      ${items.map(it => `
        <tr>
          <td><strong>${it.crop_name}</strong><br><small style="color:#6B7280;">Direct Farm Harvest</small></td>
          <td style="text-align:center;">${it.quantity} kg</td>
          <td style="text-align:right;">₹${it.unit_price}</td>
          <td style="text-align:right;"><strong>₹${it.total_price}</strong></td>
        </tr>
      `).join('')}
    </tbody>
  </table>

  <div class="totals">
    <div class="tot-row"><span>Produce Subtotal:</span> <strong>₹${invoice.subtotal}</strong></div>
    <div class="tot-row"><span>Agri Delivery / Freight:</span> <span>₹${invoice.delivery_charges}</span></div>
    <div class="tot-row"><span>Platform Trade Facilitation (2%):</span> <span>₹${invoice.platform_fee}</span></div>
    <div class="tot-row"><span>Taxes (0% Fresh Produce):</span> <span>₹${invoice.tax_amount}</span></div>
    <div class="tot-row grand"><span>Final Total:</span> <span>₹${invoice.total_amount}</span></div>
  </div>

  <div style="margin-top: 60px; padding-top: 20px; border-top: 1px solid #E2E8F0; font-size: 12px; color: #6B7280; text-align: center;">
    Thank you for supporting Indian agricultural growers directly on <strong>Farm Direct</strong>.<br>
    Zero commission intermediaries. 100% field traceability.
  </div>
</body>
</html>
    `;

    res.setHeader('Content-Type', 'text/html');
    res.send(html);
  } catch (err) {
    console.error('GET /api/invoices/:id/print error:', err.message);
    res.status(500).send('Failed to render invoice');
  }
});

// 3. GET INVOICES FOR BUYER
router.get('/buyer/:buyerId', verifyToken, async (req, res) => {
  try {
    const buyerId = parseInt(req.params.buyerId, 10);
    if (req.user.id !== buyerId && !['admin', 'super_admin'].includes(req.user.role)) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    const [invoices] = await db.query(
      `SELECT invoices.*, orders.status AS order_status 
       FROM invoices 
       JOIN orders ON invoices.order_id = orders.id 
       WHERE invoices.buyer_id = ? 
       ORDER BY invoices.id DESC`,
      [buyerId]
    );
    res.json(invoices);
  } catch (err) {
    console.error('GET /api/invoices/buyer error:', err.message);
    res.status(500).json({ error: 'Failed to fetch invoices' });
  }
});

// 4. GET INVOICES FOR FARMER
router.get('/farmer/:farmerId', verifyToken, async (req, res) => {
  try {
    const farmerId = parseInt(req.params.farmerId, 10);
    if (req.user.id !== farmerId && !['admin', 'super_admin'].includes(req.user.role)) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    const [invoices] = await db.query(
      `SELECT invoices.*, orders.status AS order_status 
       FROM invoices 
       JOIN orders ON invoices.order_id = orders.id 
       WHERE invoices.farmer_id = ? 
       ORDER BY invoices.id DESC`,
      [farmerId]
    );
    res.json(invoices);
  } catch (err) {
    console.error('GET /api/invoices/farmer error:', err.message);
    res.status(500).json({ error: 'Failed to fetch invoices' });
  }
});

module.exports = router;
