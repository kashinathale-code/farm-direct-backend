const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const db = require('../db');
require('dotenv').config();

const router = express.Router();

// --- REGISTRATION ROUTE ---
router.post('/register', async (req, res) => {
  try {
    const { name, email, password, role, location } = req.body;

    if (!name || !email || !password || !role) {
      return res.status(400).json({ error: 'Missing required fields' });
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
      'INSERT INTO users (name, email, password, role, location) VALUES (?, ?, ?, ?, ?)',
      [name, email, hashedPassword, role, location || '']
    );

    res.status(201).json({ message: 'User registered successfully', userId: result.insertId });
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

    // 2. Verify Password hash
    const storedHash = user.password || user.password_hash;
    if (!storedHash) {
      return res.status(500).json({ error: 'Password missing in database record' });
    }

    const passwordMatches = await bcrypt.compare(password, storedHash);

    if (!passwordMatches) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    // 3. Generate JWT
    const token = jwt.sign(
      { id: user.id, role: user.role, name: user.name },
      process.env.JWT_SECRET || 'fallback_secret',
      { expiresIn: '7d' }
    );

    res.json({
      message: 'Login successful',
      token,
      user: { id: user.id, name: user.name, role: user.role, location: user.location }
    });
  } catch (err) {
    console.error("Login Error:", err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;