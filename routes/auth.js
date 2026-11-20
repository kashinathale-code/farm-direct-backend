const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const db = require('../db');
const { recordAuditLog } = require('../middleware/auth');
require('dotenv').config();

const router = express.Router();

// --- REGISTRATION ROUTE (Public) ---
router.post('/register', async (req, res) => {
  try {
    const { name, email, password, role, location, phone, business_name, gstin, fpo_registration_number } = req.body;

    if (!name || !email || !password || !role) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Security: Only allow public registration for standard end-user roles
    const ALLOWED_PUBLIC_ROLES = ['farmer', 'buyer', 'business_buyer', 'fpo_manager'];
    const requestedRole = (role || '').toLowerCase().trim();

    if (!ALLOWED_PUBLIC_ROLES.includes(requestedRole)) {
      return res.status(403).json({ 
        error: `Public registration is restricted. Role '${role}' requires administrative invitation or creation.` 
      });
    }

    // 1. Check if user already exists
    const [existing] = await db.query('SELECT id FROM users WHERE email = ?', [email]);
    if (existing.length > 0) {
      return res.status(400).json({ error: 'Email already registered' });
    }

    // 2. Hash the password securely
    const hashedPassword = await bcrypt.hash(password, 10);

    // 3. Insert into TiDB MySQL database
    const [result] = await db.query(
      `INSERT INTO users (name, email, password, role, status, location, phone, business_name, gstin, fpo_registration_number) 
       VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)`,
      [
        name.trim(), 
        email.trim().toLowerCase(), 
        hashedPassword, 
        requestedRole, 
        location || '',
        phone || null,
        business_name || null,
        gstin || null,
        fpo_registration_number || null
      ]
    );

    res.status(201).json({ 
      message: 'User registered successfully', 
      userId: result.insertId,
      role: requestedRole 
    });
  } catch (err) {
    console.error("Registration Error:", err.message);
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
});

// --- LOGIN ROUTE ---
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }

    // 1. Fetch user from TiDB
    const [users] = await db.query('SELECT * FROM users WHERE email = ?', [email]);
    if (users.length === 0) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const user = users[0];

    // 2. Check account status
    if (user.status === 'suspended') {
      return res.status(403).json({ error: 'This account has been suspended. Please contact administrator support.' });
    }

    // 3. Verify Password hash
    const storedHash = user.password || user.password_hash;
    if (!storedHash) {
      return res.status(500).json({ error: 'Password missing in database record' });
    }

    const passwordMatches = await bcrypt.compare(password, storedHash);

    if (!passwordMatches) {
      if (['admin', 'super_admin'].includes(user.role)) {
        await recordAuditLog(user.id, user.role, 'ADMIN_LOGIN_FAILED', 'users', user.id, { email }, req);
      }
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    // 4. Generate JWT
    const token = jwt.sign(
      { id: user.id, role: user.role, name: user.name },
      process.env.JWT_SECRET || 'fallback_secret',
      { expiresIn: '7d' }
    );

    // Record admin logins in audit_logs
    if (['admin', 'super_admin'].includes(user.role)) {
      await recordAuditLog(user.id, user.role, 'ADMIN_LOGIN_SUCCESS', 'users', user.id, { email }, req);
    }

    res.json({
      message: 'Login successful',
      token,
      user: { 
        id: user.id, 
        name: user.name, 
        email: user.email, 
        role: user.role, 
        status: user.status || 'active',
        location: user.location,
        district: user.district,
        phone: user.phone
      }
    });
  } catch (err) {
    console.error("Login Error:", err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// Middleware to verify JWT token
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

// GET USER PROFILE
router.get('/profile', verifyToken, async (req, res) => {
  try {
    const [users] = await db.query(
      'SELECT id, name, email, role, location, created_at FROM users WHERE id = ?',
      [req.user.id]
    );
    if (users.length === 0) return res.status(404).json({ error: 'User not found' });
    res.json(users[0]);
  } catch (err) {
    console.error("GET /api/auth/profile Error:", err);
    res.status(500).json({ error: 'Server error' });
  }
});

// UPDATE USER PROFILE (e.g. location, name)
router.put('/profile', verifyToken, async (req, res) => {
  try {
    const { name, location } = req.body;
    await db.query(
      'UPDATE users SET name = COALESCE(?, name), location = COALESCE(?, location) WHERE id = ?',
      [
        name !== undefined && name !== null ? name.trim() : null,
        location !== undefined && location !== null ? location.trim() : null,
        req.user.id
      ]
    );

    const [users] = await db.query(
      'SELECT id, name, email, role, location, created_at FROM users WHERE id = ?',
      [req.user.id]
    );
    res.json({ message: 'Profile updated successfully', user: users[0] });
  } catch (err) {
    console.error("PUT /api/auth/profile Error:", err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;