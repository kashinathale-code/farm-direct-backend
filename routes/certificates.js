// ============================================================================
// FARM DIRECT — CERTIFICATE VERIFICATION ROUTER
// ============================================================================

const express = require('express');
const db = require('../db');
const { verifyToken, requireRole, recordAuditLog } = require('../middleware/auth');
const { createNotification } = require('./notifications');

const router = express.Router();

// 1. FARMER UPLOAD / SUBMIT AGRICULTURAL CERTIFICATE
router.post('/', verifyToken, requireRole('farmer', 'fpo_manager', 'admin', 'super_admin'), async (req, res) => {
  try {
    const { certificate_type, certificate_number, issuing_authority, issue_date, expiry_date, document_url } = req.body;
    if (!certificate_type || !certificate_number || !issuing_authority || !issue_date || !expiry_date) {
      return res.status(400).json({ error: 'All certificate metadata fields are required' });
    }

    const [result] = await db.query(
      `INSERT INTO certificates 
        (farmer_id, certificate_type, certificate_number, issuing_authority, issue_date, expiry_date, document_url, verification_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`,
      [req.user.id, certificate_type.trim(), certificate_number.trim(), issuing_authority.trim(), issue_date, expiry_date, document_url || null]
    );

    res.status(201).json({
      message: 'Certificate submitted for administrative verification',
      certificate_id: result.insertId,
      status: 'pending'
    });
  } catch (err) {
    console.error('POST /api/certificates error:', err.message);
    res.status(500).json({ error: 'Failed to submit certificate' });
  }
});

// 2. GET CERTIFICATES FOR A FARMER
router.get('/farmer/:farmerId', async (req, res) => {
  try {
    const farmerId = parseInt(req.params.farmerId, 10);
    const [rows] = await db.query(
      `SELECT id, farmer_id, certificate_type, certificate_number, issuing_authority, issue_date, expiry_date, verification_status, rejection_reason, verified_at, created_at 
       FROM certificates 
       WHERE farmer_id = ? 
       ORDER BY id DESC`,
      [farmerId]
    );

    // Dynamic check for expired certificates
    const today = new Date().toISOString().slice(0, 10);
    const checked = rows.map(c => {
      let vStatus = c.verification_status;
      if (vStatus === 'verified' && c.expiry_date && c.expiry_date < today) {
        vStatus = 'expired';
      }
      return { ...c, verification_status: vStatus };
    });

    res.json(checked);
  } catch (err) {
    console.error('GET /api/certificates/farmer error:', err.message);
    res.status(500).json({ error: 'Failed to fetch certificates' });
  }
});

// 3. ADMIN GET PENDING CERTIFICATES
router.get('/pending', verifyToken, requireRole('admin', 'super_admin'), async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT certificates.*, users.name AS farmer_name, users.email AS farmer_email, users.location AS farmer_location 
       FROM certificates 
       JOIN users ON certificates.farmer_id = users.id 
       ORDER BY certificates.id DESC LIMIT 100`
    );
    res.json(rows);
  } catch (err) {
    console.error('GET /api/certificates/pending error:', err.message);
    res.status(500).json({ error: 'Failed to fetch pending certificates' });
  }
});

// 4. ADMIN REVIEW CERTIFICATE (Verify or Reject)
router.put('/:id/review', verifyToken, requireRole('admin', 'super_admin'), async (req, res) => {
  try {
    const certId = parseInt(req.params.id, 10);
    const { status, rejection_reason } = req.body;

    if (!['verified', 'rejected', 'under_review', 'pending'].includes(status)) {
      return res.status(400).json({ error: 'Invalid verification status' });
    }

    const [certs] = await db.query(`SELECT * FROM certificates WHERE id = ?`, [certId]);
    if (certs.length === 0) return res.status(404).json({ error: 'Certificate not found' });
    const cert = certs[0];

    await db.query(
      `UPDATE certificates 
       SET verification_status = ?, rejection_reason = ?, verified_by = ?, verified_at = CURRENT_TIMESTAMP 
       WHERE id = ?`,
      [status, rejection_reason || null, req.user.id, certId]
    );

    // Notify farmer
    await createNotification(
      cert.farmer_id,
      `Certificate ${status === 'verified' ? 'Verified ✓' : 'Status Update'}`,
      `Your ${cert.certificate_type} (#${cert.certificate_number}) has been marked as '${status}'.`,
      'farmer-dashboard.html',
      'certificate'
    );

    await recordAuditLog(
      req.user.id,
      req.user.role,
      `CERTIFICATE_${status.toUpperCase()}`,
      'certificates',
      certId,
      { certificate_type: cert.certificate_type, status, rejection_reason },
      req
    );

    res.json({ message: `Certificate status updated to: ${status}` });
  } catch (err) {
    console.error('PUT /api/certificates/:id/review error:', err.message);
    res.status(500).json({ error: 'Failed to review certificate' });
  }
});

module.exports = router;
