const express = require('express');
const jwt = require('jsonwebtoken');
const db = require('../db');
require('dotenv').config();

const router = express.Router();

// Optional JWT extraction for personalized order status queries
function optionalAuth(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return next();

  jwt.verify(token, process.env.JWT_SECRET || 'fallback_secret', (err, decoded) => {
    if (!err) req.user = decoded;
    next();
  });
}

// Intelligent rule-based assistant that works 100% offline without requiring paid API keys
async function generateRuleBasedReply(query, user, cropList, orderList) {
  const q = query.toLowerCase();

  // 1. Order status query (Authenticated)
  if (q.includes('my order') || q.includes('order status') || q.includes('where is my order')) {
    if (!user) {
      return "To check your order status, please log in with your Farm Direct account, or visit the **My Orders** section on your dashboard!";
    }
    if (!orderList || orderList.length === 0) {
      return `Hello ${user.name}! You currently don't have any active orders. You can browse fresh crops in the marketplace and place an order anytime.`;
    }
    const orderLines = orderList.slice(0, 3).map(o => 
      `• **Order #${o.id}**: ${o.quantity}kg of ${o.crop_name} (${o.status.toUpperCase()}) — Total: ₹${o.total_price}`
    ).join('\n');
    return `Hello ${user.name}! Here are your recent orders:\n${orderLines}\n\nYou can click on any order in your dashboard for full status timeline tracking and direct messaging with the farmer.`;
  }

  // 2. Budget queries ("under 50", "budget 100", "cheap", "cheapest")
  const budgetMatch = q.match(/(?:under|below|budget|within|less than)\s*(?:₹|rs\.?|inr)?\s*(\d+)/i);
  if (budgetMatch || q.includes('cheapest') || q.includes('budget') || q.includes('affordable')) {
    const budgetLimit = budgetMatch ? parseFloat(budgetMatch[1]) : 100;
    const affordable = cropList.filter(c => parseFloat(c.price_per_kg) <= budgetLimit);

    if (affordable.length === 0) {
      const minPriceCrop = [...cropList].sort((a,b) => parseFloat(a.price_per_kg) - parseFloat(b.price_per_kg))[0];
      return `Currently, no listed crops are under ₹${budgetLimit}/kg. The most affordable listing right now is **${minPriceCrop?.crop_name || 'produce'}** at ₹${minPriceCrop?.price_per_kg}/kg from ${minPriceCrop?.farmer_name}.`;
    }

    const suggestions = affordable.slice(0, 4).map(c => 
      `• **${c.crop_name}** (${c.category}): ₹${c.price_per_kg}/kg · ${c.quantity_available}kg in stock (Farmer: ${c.farmer_name}, ${c.location || 'India'})`
    ).join('\n');
    return `Here are available crops fitting a budget under ₹${budgetLimit}/kg:\n${suggestions}\n\nYou can order these directly or use our **Price Negotiation** feature if bidding is enabled!`;
  }

  // 3. Price comparison queries ("compare tomato and onion")
  if (q.includes('compare') || q.includes('versus') || q.includes('vs')) {
    const foundCrops = cropList.filter(c => q.includes(c.crop_name.toLowerCase()));
    if (foundCrops.length >= 2) {
      const compareLines = foundCrops.map(c => 
        `• **${c.crop_name}**: ₹${c.price_per_kg}/kg (${c.quantity_available}kg available from ${c.farmer_name} in ${c.location || 'India'})`
      ).join('\n');
      return `Marketplace price comparison:\n${compareLines}\n\nAll prices are set directly by farmers without middlemen commissions!`;
    }
  }

  // 4. Category specific queries ("vegetables", "fruits", "grains", "pulses", "spices")
  const categories = ['vegetables', 'fruits', 'grains', 'pulses', 'spices'];
  const matchedCat = categories.find(cat => q.includes(cat));
  if (matchedCat) {
    const catCrops = cropList.filter(c => (c.category || '').toLowerCase() === matchedCat);
    if (catCrops.length === 0) {
      return `There are currently no listings in the **${matchedCat.toUpperCase()}** category. Please check back soon or browse other fresh categories like vegetables or grains!`;
    }
    const catLines = catCrops.slice(0, 4).map(c => 
      `• **${c.crop_name}**: ₹${c.price_per_kg}/kg · ${c.quantity_available}kg available (Farmer: ${c.farmer_name})`
    ).join('\n');
    return `Here are the currently available ${matchedCat}:\n${catLines}\n\nYou can use the category filter chips on the Buyer Dashboard to filter immediately!`;
  }

  // 5. Group buying explanation
  if (q.includes('group buy') || q.includes('group-buy') || q.includes('community buy') || q.includes('bulk')) {
    return "💡 **Community Group Buying on Farm Direct**:\nFarmers can launch bulk group-buying campaigns with discounted per-kg rates. Multiple buyers commit quantities toward a shared target (e.g. 50kg). Once the target is reached, everyone secures the discounted price and orders are automatically created!";
  }

  // 6. Bidding & Price Negotiation explanation
  if (q.includes('bid') || q.includes('bidding') || q.includes('negotiat') || q.includes('offer') || q.includes('counteroffer')) {
    return "🤝 **Price Negotiation on Farm Direct**:\nWhen a farmer enables negotiation on a listing, buyers can submit custom price offers. The farmer can accept, reject, or propose a counteroffer. Once both parties agree, an order is instantly created at the negotiated price!";
  }

  // 7. QR Traceability explanation
  if (q.includes('qr') || q.includes('trace') || q.includes('traceability') || q.includes('origin')) {
    return "🔍 **Farm Direct QR Traceability**:\nEvery listed crop gets a unique QR code. Buyers can scan it with their phone camera to view the crop's harvest date, farming region, farmer name, and transparent listing history on our public traceability page!";
  }

  // 8. How to order / buy
  if (q.includes('how to order') || q.includes('how to buy') || q.includes('place order')) {
    return "🛒 **How to place an order**:\n1. Log in to your **Buyer Dashboard**.\n2. Browse available crops or filter by category and price.\n3. Enter your desired quantity (in kg) on any crop card and click **Order now**.\n4. Track your order timeline and message the farmer directly from your dashboard!";
  }

  // 9. How to sell / farmer guide
  if (q.includes('how to sell') || q.includes('farmer') || q.includes('list crop') || q.includes('add crop')) {
    return "🌾 **How to sell crops**:\n1. Register or log in with a **Farmer** account.\n2. In the **Farmer Dashboard**, fill in the 'Add New Crop' form (Name, Category, Price/kg, Available Quantity, Harvest Date, and Photo).\n3. Optionally enable Price Negotiation or Community Group Buying to reach more buyers!\n4. Receive and manage incoming buyer orders directly.";
  }

  // Default overview with live produce highlights
  const topProduce = cropList.slice(0, 3).map(c => `• **${c.crop_name}** at ₹${c.price_per_kg}/kg`).join('\n');
  return `Hello! I am your **Farm Direct AI Assistant**. 🚜\n\nI can help you with:\n• Finding crops by budget or category\n• Comparing prices of fresh produce\n• Explaining Price Bidding, Group Buying, and QR Traceability\n• Checking your order status\n\n**Currently Available in Market**:\n${topProduce || 'Produce available on dashboard'}\n\nWhat would you like to know?`;
}

// MAIN ASSISTANT CHAT ENDPOINT
router.post('/chat', optionalAuth, async (req, res) => {
  try {
    const { message } = req.body;
    if (!message || typeof message !== 'string' || message.trim().length === 0) {
      return res.status(400).json({ error: 'Message text is required' });
    }

    if (message.length > 500) {
      return res.status(400).json({ error: 'Message must be under 500 characters' });
    }

    // 1. Fetch real active crops from database
    const [crops] = await db.query(
      `SELECT 
         crops.id, 
         crops.crop_name, 
         crops.category, 
         crops.price_per_kg, 
         crops.quantity_available, 
         crops.bidding_enabled,
         crops.harvest_date,
         users.name AS farmer_name, 
         users.location 
       FROM crops 
       JOIN users ON crops.farmer_id = users.id 
       WHERE crops.quantity_available > 0
       ORDER BY crops.id DESC 
       LIMIT 25`
    );

    // 2. Fetch authenticated user's recent orders (if logged in)
    let userOrders = [];
    if (req.user) {
      const [orders] = await db.query(
        `SELECT orders.id, orders.quantity, orders.total_price, orders.status, crops.crop_name 
         FROM orders 
         JOIN crops ON orders.crop_id = crops.id 
         WHERE orders.buyer_id = ? 
         ORDER BY orders.id DESC 
         LIMIT 5`,
        [req.user.id]
      );
      userOrders = orders;
    }

    // 3. Check for external LLM API keys (e.g. GEMINI_API_KEY)
    const geminiKey = process.env.GEMINI_API_KEY;
    if (geminiKey) {
      try {
        const cropSummary = crops.map(c => 
          `- ${c.crop_name} (${c.category}): ₹${c.price_per_kg}/kg, ${c.quantity_available}kg available from farmer ${c.farmer_name} in ${c.location || 'India'}. Bidding enabled: ${c.bidding_enabled ? 'Yes' : 'No'}.`
        ).join('\n');

        const systemPrompt = `You are the helpful AI Assistant for Farm Direct, a direct-to-consumer agriculture marketplace connecting Indian farmers with buyers.
Always answer accurately based strictly on this verified live marketplace data:
${cropSummary}

User status: ${req.user ? `Logged in as ${req.user.name} (${req.user.role})` : 'Guest visitor'}.
${userOrders.length > 0 ? `User's recent orders: ${JSON.stringify(userOrders)}` : ''}

Guidelines:
- Keep answers friendly, professional, concise, and helpful.
- Never invent prices, crops, or stock that are not in the listed data.
- Explain Farm Direct features (Direct trade, Bidding, Group buying, QR traceability) accurately.`;

        // Call Gemini REST API
        const geminiRes = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${geminiKey}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [
                { role: 'user', parts: [{ text: `${systemPrompt}\n\nUser Question: ${message}` }] }
              ]
            })
          }
        );

        if (geminiRes.ok) {
          const geminiData = await geminiRes.json();
          const replyText = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text;
          if (replyText) {
            return res.json({ reply: replyText, source: 'ai' });
          }
        }
      } catch (geminiErr) {
        console.warn('Gemini API call failed, falling back to smart rule engine:', geminiErr.message);
      }
    }

    // 4. Guaranteed high-accuracy rule-based assistant fallback
    const reply = await generateRuleBasedReply(message, req.user, crops, userOrders);
    res.json({ reply, source: 'marketplace-engine' });
  } catch (err) {
    console.error('POST /assistant/chat error:', err.message);
    res.status(500).json({ 
      reply: "I am having trouble connecting to the marketplace database right now. Please try again in a few moments or browse the live dashboard listings!",
      source: 'fallback'
    });
  }
});

module.exports = router;
