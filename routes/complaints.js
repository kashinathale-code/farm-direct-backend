// ============================================================================
// FARM DIRECT — SUPPORT & COMPLAINT RESOLUTION ROUTER
// ============================================================================

const express = require('express');
const db = require('../db');
const { verifyToken, requireRole, recordAuditLog } = require('../middleware/auth');

const router = express.Router();

// Helper to generate ticket number
function generateTicketNumber() {
  return `TKT-${Date.now().toString(36).toUpperCase()}-${Math.floor(100 + Math.random() * 900)}`;
}

// 1. SUBMIT A COMPLAINT TICKET
router.post('/', verifyToken, async (req, res) => {
  try {
    const { category, order_id, subject, description, priority } = req.body;
    if (!category || !subject || !description) {
      return res.status(400).json({ error: 'Category, subject, and description are required' });
    }

    const ticketNumber = generateTicketNumber();
    const [result] = await db.query(
      `INSERT INTO complaints (ticket_number, user_id, user_role, category, order_id, subject, description, priority, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open')`,
      [
        ticketNumber,
        req.user.id,
        req.user.role,
        category,
        order_id ? parseInt(order_id, 10) : null,
        subject.trim(),
        description.trim(),
        priority || 'medium'
      ]
    );

    res.status(201).json({
      message: 'Support ticket submitted successfully',
      ticket_id: result.insertId,
      ticket_number: ticketNumber
    });
  } catch (err) {
    console.error('POST /api/complaints error:', err.message);
    res.status(500).json({ error: 'Failed to submit complaint' });
  }
});

// 2. GET CURRENT USER'S COMPLAINTS
router.get('/user', verifyToken, async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT * FROM complaints WHERE user_id = ? ORDER BY id DESC`,
      [req.user.id]
    );
    res.json(rows);
  } catch (err) {
    console.error('GET /api/complaints/user error:', err.message);
    res.status(500).json({ error: 'Failed to fetch user complaints' });
  }
});

// 3. ADMIN GET ALL COMPLAINTS
router.get('/all', verifyToken, requireRole('admin', 'super_admin'), async (req, res) => {
  try {
    const { status, category } = req.query;
    let sql = `
      SELECT complaints.*, users.name AS user_name, users.email AS user_email, users.phone AS user_phone 
      FROM complaints 
      JOIN users ON complaints.user_id = users.id 
      WHERE 1=1
    `;
    const params = [];

    if (status) {
      sql += ` AND complaints.status = ?`;
      params.push(status);
    }
    if (category) {
      sql += ` AND complaints.category = ?`;
      params.push(category);
    }

    sql += ` ORDER BY complaints.id DESC LIMIT 150`;
    const [rows] = await db.query(sql, params);
    res.json(rows);
  } catch (err) {
    console.error('GET /api/complaints/all error:', err.message);
    res.status(500).json({ error: 'Failed to fetch all complaints' });
  }
});

// 4. ADMIN RESOLVE OR UPDATE COMPLAINT
router.put('/:id/resolve', verifyToken, requireRole('admin', 'super_admin'), async (req, res) => {
  try {
    const ticketId = parseInt(req.params.id, 10);
    const { status, admin_notes } = req.body;

    if (!['open', 'investigating', 'resolved', 'closed'].includes(status)) {
      return res.status(400).json({ error: 'Invalid complaint status' });
    }

    await db.query(
      `UPDATE complaints 
       SET status = ?, admin_notes = COALESCE(?, admin_notes), resolved_by = ?, resolved_at = CURRENT_TIMESTAMP 
       WHERE id = ?`,
      [status, admin_notes || null, req.user.id, ticketId]
    );

    await recordAuditLog(
      req.user.id,
      req.user.role,
      `RESOLVE_COMPLAINT_${status.toUpperCase()}`,
      'complaints',
      ticketId,
      { status, admin_notes },
      req
    );

    res.json({ message: `Complaint status updated to ${status}` });
  } catch (err) {
    console.error('PUT /api/complaints/:id/resolve error:', err.message);
    res.status(500).json({ error: 'Failed to update complaint' });
  }
});

module.exports = router;
