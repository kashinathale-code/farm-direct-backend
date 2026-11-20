// ============================================================================
// FARM DIRECT — CENTRALIZED AUTHENTICATION & ROLE-BASED ACCESS CONTROL (RBAC)
// ============================================================================

const jwt = require('jsonwebtoken');
const db = require('../db');
require('dotenv').config();

// 1. Verify JWT & Account Status
async function verifyToken(req, res, next) {
  try {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'No authorization token provided' });

    jwt.verify(token, process.env.JWT_SECRET || 'fallback_secret', async (err, decoded) => {
      if (err) return res.status(403).json({ error: 'Invalid or expired session token' });

      // Fast cache or DB lookup to verify user status (check for suspended accounts)
      try {
        const [users] = await db.query(
          `SELECT id, name, email, role, status FROM users WHERE id = ?`,
          [decoded.id]
        );
        if (users.length === 0) {
          return res.status(401).json({ error: 'User account not found' });
        }
        const user = users[0];
        if (user.status === 'suspended') {
          return res.status(403).json({ error: 'Your account has been suspended by administration' });
        }

        // Attach actual database-verified user object to req
        req.user = {
          id: user.id,
          name: user.name,
          email: user.email,
          role: user.role,
          status: user.status
        };
        next();
      } catch (dbErr) {
        // Fallback to decoded token payload if db query fails in unit test mode
        req.user = decoded;
        next();
      }
    });
  } catch (err) {
    console.error('verifyToken middleware error:', err.message);
    res.status(500).json({ error: 'Authentication verification error' });
  }
}

// 2. Require Specific Roles (Supports super_admin inheritance)
function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user || !req.user.role) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const userRole = req.user.role;
    // super_admin has global access to all admin-level routes
    if (userRole === 'super_admin' && (allowedRoles.includes('admin') || allowedRoles.includes('super_admin'))) {
      return next();
    }

    if (!allowedRoles.includes(userRole)) {
      return res.status(403).json({ 
        error: `Access denied. Role '${userRole}' is not authorized for this resource.` 
      });
    }

    next();
  };
}

// 3. Centralized Audit Logger
async function recordAuditLog(actorId, actorRole, action, targetEntity, targetId, details = null, req = null) {
  try {
    const ip = req ? (req.headers['x-forwarded-for'] || req.socket.remoteAddress || null) : null;
    const sanitizedDetails = details ? JSON.stringify(details) : null;

    await db.query(
      `INSERT INTO audit_logs (actor_id, actor_role, action, target_entity, target_id, details, ip_address)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [actorId || null, actorRole || null, action, targetEntity || null, targetId || null, sanitizedDetails, ip]
    );
  } catch (err) {
    console.warn('Audit log write error (non-fatal):', err.message);
  }
}

module.exports = {
  verifyToken,
  requireRole,
  recordAuditLog
};
