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

    const [existing] = await db.query('SELECT id FROM users WHERE email = ?', [email]);
    if (existing.length > 0) {
      return res.status(400).json({ error: 'Email already registered' });
    }

    // Hash the password securely
    const password_hash = await bcrypt.hash(password, 10);

    try {
      // FIX APPLIED HERE: Changed 'password_hash' to 'password' in the SQL column list
      const [result] = await db.query(
        'INSERT INTO users (name, email, password, role, location) VALUES (?, ?, ?, ?, ?)',
        [name, email, password_hash, role, location]
      );

      res.status(201).json({ message: 'User registered successfully', userId: result.insertId });
    } catch (dbErr) {
      console.error("Database Insert Error:", dbErr.message);
      return res.status(500).json({ error: 'Database error: ' + dbErr.message });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// --- LOGIN ROUTE ---
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }

    const [users] = await db.query('SELECT * FROM users WHERE email = ?', [email]);
    if (users.length === 0) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const user = users[0];
    
    // FIX APPLIED HERE: Changed 'user.password_hash' to 'user.password'
    const passwordMatches = await bcrypt.compare(password, user.password);

    if (!passwordMatches) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const token = jwt.sign(
      { id: user.id, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      message: 'Login successful',
      token,
      user: { id: user.id, name: user.name, role: user.role }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;