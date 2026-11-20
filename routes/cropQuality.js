// ============================================================================
// FARM DIRECT — CROP QUALITY ASSISTANT ROUTER
// ============================================================================

const express = require('express');
const db = require('../db');
const { verifyToken, requireRole, recordAuditLog } = require('../middleware/auth');
const { assessCropPhoto } = require('../services/cropQualityService');

const router = express.Router();

// 1. SUBMIT CROP PHOTO FOR QUALITY ASSESSMENT
router.post('/assess', verifyToken, async (req, res) => {
  try {
    const { image, crop_name, crop_id } = req.body;
    if (!image) {
      return res.status(400).json({ error: 'Crop photograph image is required' });
    }

    // Call quality assessment service
    const assessment = await assessCropPhoto(image, crop_name || '');

    // Persist assessment to crop_quality_assessments
    const [result] = await db.query(
      `INSERT INTO crop_quality_assessments 
        (crop_id, farmer_id, image_url, crop_type_detected, quality_grade, confidence_score, visual_defects, observed_characteristics, recommendations, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'completed')`,
      [
        crop_id ? parseInt(crop_id, 10) : null,
        req.user.id,
        image.slice(0, 10000), // preview slice or full
        assessment.crop_type_detected,
        assessment.quality_grade,
        assessment.confidence_score,
        JSON.stringify(assessment.visual_defects || []),
        JSON.stringify(assessment.observed_characteristics || {}),
        assessment.recommendations
      ]
    );

    res.status(201).json({
      assessment_id: result.insertId,
      ...assessment
    });
  } catch (err) {
    console.error('POST /api/crop-quality/assess error:', err.message);
    res.status(500).json({ error: 'Failed to complete crop quality assessment: ' + err.message });
  }
});

// 2. GET ASSESSMENT HISTORY FOR A FARMER
router.get('/history/farmer/:id', verifyToken, async (req, res) => {
  try {
    const farmerId = parseInt(req.params.id, 10);
    // Security check: farmer themselves or admin
    if (req.user.id !== farmerId && !['admin', 'super_admin'].includes(req.user.role)) {
      return res.status(403).json({ error: 'Not authorized to view these assessments' });
    }

    const [rows] = await db.query(
      `SELECT * FROM crop_quality_assessments WHERE farmer_id = ? ORDER BY id DESC LIMIT 50`,
      [farmerId]
    );

    const parsed = rows.map(r => ({
      ...r,
      visual_defects: typeof r.visual_defects === 'string' ? JSON.parse(r.visual_defects) : (r.visual_defects || []),
      observed_characteristics: typeof r.observed_characteristics === 'string' ? JSON.parse(r.observed_characteristics) : (r.observed_characteristics || {})
    }));

    res.json(parsed);
  } catch (err) {
    console.error('GET /api/crop-quality/history error:', err.message);
    res.status(500).json({ error: 'Failed to fetch assessment history' });
  }
});

// 3. GET ASSESSMENT FOR A SPECIFIC CROP
router.get('/crop/:cropId', async (req, res) => {
  try {
    const cropId = parseInt(req.params.cropId, 10);
    const [rows] = await db.query(
      `SELECT * FROM crop_quality_assessments WHERE crop_id = ? ORDER BY id DESC LIMIT 1`,
      [cropId]
    );

    if (rows.length === 0) {
      return res.status(404).json({ message: 'No AI assessment record found for this crop' });
    }

    const r = rows[0];
    res.json({
      ...r,
      visual_defects: typeof r.visual_defects === 'string' ? JSON.parse(r.visual_defects) : (r.visual_defects || []),
      observed_characteristics: typeof r.observed_characteristics === 'string' ? JSON.parse(r.observed_characteristics) : (r.observed_characteristics || {})
    });
  } catch (err) {
    console.error('GET /api/crop-quality/crop/:id error:', err.message);
    res.status(500).json({ error: 'Failed to fetch crop assessment' });
  }
});

// 4. ADMIN REVIEW ASSESSMENT
router.put('/:id/review', verifyToken, requireRole('admin', 'super_admin'), async (req, res) => {
  try {
    const assessmentId = parseInt(req.params.id, 10);
    const { status, admin_notes } = req.body;

    await db.query(
      `UPDATE crop_quality_assessments 
       SET status = COALESCE(?, status), admin_notes = ?, reviewed_by = ? 
       WHERE id = ?`,
      [status || null, admin_notes || null, req.user.id, assessmentId]
    );

    await recordAuditLog(
      req.user.id, 
      req.user.role, 
      'REVIEW_CROP_QUALITY_ASSESSMENT', 
      'crop_quality_assessments', 
      assessmentId, 
      { status, admin_notes },
      req
    );

    res.json({ message: 'Assessment reviewed and updated successfully' });
  } catch (err) {
    console.error('PUT /api/crop-quality/:id/review error:', err.message);
    res.status(500).json({ error: 'Failed to update assessment review' });
  }
});

module.exports = router;
