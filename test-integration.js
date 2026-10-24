/**
 * Farm Direct E2E Integration Test Suite
 * Tests all core and upgraded v2 modules against real backend and database:
 * - Auth (Farmer & Buyer)
 * - Crops CRUD + Private Reserve Price Protection
 * - QR Code Traceability (Public endpoint & PNG generator)
 * - Real-Time Bidding & Negotiation (Offer -> Counteroffer -> Accept -> Order Creation + Stock Decrement)
 * - Community Group Buying (Campaign creation -> Buyer Join -> Stock validation)
 * - Order Lifecycle & Status Timeline (History audit trail & state machine validation)
 * - Persistent Notifications (Recipient isolation, unread counter, mark as read)
 * - AI Marketplace Assistant (Live DB produce retrieval with rule-based fallback)
 */

const express = require('express');
const http = require('http');

// Load environment from .env in backend directory
require('dotenv').config({ path: __dirname + '/.env' });
const pool = require('./db');

// Import routes
const authRoutes = require('./routes/auth');
const cropsRoutes = require('./routes/crops');
const ordersRoutes = require('./routes/orders');
const messagesRoutes = require('./routes/messages');
const { router: notificationsRoutes } = require('./routes/notifications');
const bidsRoutes = require('./routes/bids');
const groupBuysRoutes = require('./routes/groupBuys');
const traceabilityRoutes = require('./routes/traceability');
const assistantRoutes = require('./routes/assistant');

const app = express();
app.use(express.json());
app.get('/api/health', (req, res) => res.json({ status: 'ok' }));
app.use('/api/auth', authRoutes);
app.use('/api/crops', cropsRoutes);
app.use('/api/orders', ordersRoutes);
app.use('/api/messages', messagesRoutes);
app.use('/api/notifications', notificationsRoutes);
app.use('/api/bids', bidsRoutes);
app.use('/api/group-buys', groupBuysRoutes);
app.use('/api/traceability', traceabilityRoutes);
app.use('/api/assistant', assistantRoutes);

let server;
let baseUrl;

async function request(method, path, body = null, token = null) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch (e) {
    json = text;
  }

  return { status: res.status, ok: res.ok, body: json };
}

let passedTests = 0;
let totalTests = 0;

function assert(condition, message) {
  totalTests++;
  if (!condition) {
    console.error(`❌ FAIL: ${message}`);
    throw new Error(`Assertion failed: ${message}`);
  }
  passedTests++;
  console.log(`  ✓ ${message}`);
}

async function runTests() {
  console.log('\n======================================================');
  console.log('🌱 STARTING FARM DIRECT E2E INTEGRATION TEST SUITE');
  console.log('======================================================\n');

  // 1. Start ephemeral HTTP server on random port
  await new Promise((resolve) => {
    server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      baseUrl = `http://127.0.0.1:${port}/api`;
      console.log(`🚀 Test server started at ${baseUrl}`);
      resolve();
    });
  });

  const testSuffix = Date.now();
  let farmerToken, farmerUser;
  let buyerToken, buyerUser;
  let testCropId, testTraceCode;
  let testBidId;
  let testOrderId;
  let testGbId;

  try {
    // TEST 1: Health Endpoint
    console.log('\n[1/8] Server Health & Connectivity');
    const health = await request('GET', '/health');
    assert(health.status === 200 && health.body.status === 'ok', 'Health check returns 200 OK');

    // TEST 2: Authentication (Farmer & Buyer)
    console.log('\n[2/8] Authentication & Role Enforcement');
    const farmerEmail = `farmer_${testSuffix}@example.com`;
    const regFarmer = await request('POST', '/auth/register', {
      name: `Ramesh Farmer ${testSuffix}`,
      email: farmerEmail,
      password: 'password123',
      role: 'farmer',
      location: 'Nashik, Maharashtra'
    });
    assert(regFarmer.status === 201, 'Farmer registration succeeds with 201');

    const logFarmer = await request('POST', '/auth/login', {
      email: farmerEmail,
      password: 'password123'
    });
    assert(logFarmer.status === 200 && logFarmer.body.token, 'Farmer login issues valid JWT');
    farmerToken = logFarmer.body.token;
    farmerUser = logFarmer.body.user;

    const buyerEmail = `buyer_${testSuffix}@example.com`;
    const regBuyer = await request('POST', '/auth/register', {
      name: `Anita Buyer ${testSuffix}`,
      email: buyerEmail,
      password: 'password123',
      role: 'buyer',
      location: 'Pune, Maharashtra'
    });
    assert(regBuyer.status === 201, 'Buyer registration succeeds with 201');

    const logBuyer = await request('POST', '/auth/login', {
      email: buyerEmail,
      password: 'password123'
    });
    assert(logBuyer.status === 200 && logBuyer.body.token, 'Buyer login issues valid JWT');
    buyerToken = logBuyer.body.token;
    buyerUser = logBuyer.body.user;

    // TEST 3: Crop Listing & Privacy Checks
    console.log('\n[3/8] Crop Management & QR Traceability');
    const addCrop = await request('POST', '/crops', {
      crop_name: `Organic Alphonso Mangoes ${testSuffix}`,
      price_per_kg: 90,
      quantity: 150,
      category: 'Fruits',
      harvest_date: '2026-04-10',
      description: 'Hand-picked export grade mangoes from Ratnagiri orchard.',
      bidding_enabled: true,
      min_bidding_price: 75
    }, farmerToken);
    assert(addCrop.status === 201, 'Farmer adds crop with bidding enabled & reserve price');
    testCropId = addCrop.body.id || addCrop.body.cropId;
    testTraceCode = addCrop.body.traceability_code;
    assert(Boolean(testTraceCode), 'Traceability code was auto-generated');

    // Verify Buyer sees crop but farmer reserve price is HIDDEN
    const buyerCrops = await request('GET', '/crops', null, buyerToken);
    assert(buyerCrops.status === 200, 'Buyer fetches public crops listing');
    const listed = buyerCrops.body.find(c => c.id === testCropId);
    assert(listed !== undefined, 'Newly listed crop is visible in marketplace');
    assert(listed.bidding_enabled === 1 || listed.bidding_enabled === true, 'Crop shows negotiation allowed');
    assert(listed.min_bidding_price === undefined || listed.min_bidding_price === null, 'CRITICAL SECURITY: Farmer reserve price is NEVER exposed to buyers');

    // Public QR Traceability
    const traceLookup = await request('GET', `/traceability/code/${testTraceCode}`);
    assert(traceLookup.status === 200, 'Public traceability endpoint accessible without token');
    assert(traceLookup.body.crop_name.includes('Alphonso Mangoes'), 'Traceability returns correct crop details');
    assert(traceLookup.body.password === undefined, 'No user credentials leaked in traceability payload');

    const qrImage = await request('GET', `/traceability/qr/${testTraceCode}`);
    assert(qrImage.status === 200 && qrImage.body.qr_code && qrImage.body.qr_code.startsWith('data:image/png;base64,'), 'QR code generated as high-resolution PNG data URL');

    // TEST 4: Bidding and Price Negotiation Workflow
    console.log('\n[4/8] Bidding & Offer Negotiation Workflow');
    // Buyer places offer of 40kg @ ₹80/kg (above reserve of 75)
    const placeBid = await request('POST', '/bids', {
      crop_id: testCropId,
      offered_price_per_kg: 80,
      offered_quantity: 40,
      notes: 'Can take 40kg if packed in crates.'
    }, buyerToken);
    assert(placeBid.status === 201, 'Buyer submits valid purchase offer');
    testBidId = placeBid.body.bidId;

    // Farmer views bids
    const farmerBids = await request('GET', '/bids/farmer', null, farmerToken);
    assert(farmerBids.status === 200 && farmerBids.body.some(b => b.id === testBidId), 'Farmer receives incoming negotiation in dashboard');

    // Farmer counteroffers @ ₹85/kg
    const counterRes = await request('POST', `/bids/${testBidId}/counter`, {
      counter_price_per_kg: 85,
      notes: 'Best I can do for export-quality crating is 85.'
    }, farmerToken);
    assert(counterRes.status === 200, 'Farmer submits counteroffer');

    // Buyer views their bids and sees the counteroffer
    const buyerBids = await request('GET', '/bids/buyer', null, buyerToken);
    const myBid = buyerBids.body.find(b => b.id === testBidId);
    assert(myBid.status === 'countered' && Number(myBid.counter_price_per_kg) === 85, 'Buyer sees counteroffer state and price');

    // Buyer accepts counteroffer -> Should trigger DB transaction, create order, and decrement stock
    const acceptRes = await request('POST', `/bids/${testBidId}/accept`, {}, buyerToken);
    assert(acceptRes.status === 200 && acceptRes.body.orderId, 'Buyer accepts offer and backend creates confirmed order');
    testOrderId = acceptRes.body.orderId;

    // Verify stock decremented from 150 to 110
    const [cropRows] = await pool.query('SELECT quantity_available FROM crops WHERE id = ?', [testCropId]);
    assert(cropRows[0].quantity_available === 110, `Crop stock decremented accurately to 110 (was 150 - 40)`);

    // TEST 5: Community Group Buying
    console.log('\n[5/8] Community Group Buying Co-Op System');
    const gbRes = await request('POST', '/group-buys', {
      crop_id: testCropId,
      title: `Bulk Mango Co-Op Batch ${testSuffix}`,
      target_quantity: 50,
      discount_price_per_kg: 78,
      end_date: '2027-05-30',
      description: 'Group order for community societies.'
    }, farmerToken);
    assert(gbRes.status === 201, 'Farmer launches group buy campaign');
    testGbId = gbRes.body.id || gbRes.body.campaignId;

    // Buyer joins group buy with 20kg
    const joinGb = await request('POST', `/group-buys/${testGbId}/join`, {
      quantity: 20
    }, buyerToken);
    assert(joinGb.status === 200, 'Buyer commits 20kg to group campaign');

    // Check campaign committed volume
    const gbDetails = await request('GET', `/group-buys/${testGbId}`);
    assert(Number(gbDetails.body.committed_quantity) === 20, 'Group buy committed quantity updated to 20kg');
    assert(gbDetails.body.participants.length === 1, 'Group buy shows 1 active participant');

    // TEST 6: Order Lifecycle & Timeline
    console.log('\n[6/8] Order Fulfillment Lifecycle & Audit Trail');
    // Progress order: accepted -> processing -> shipped -> delivered
    const st1 = await request('PUT', `/orders/${testOrderId}/status`, { status: 'processing', note: 'Packing into ventilated crates' }, farmerToken);
    assert(st1.status === 200, 'Farmer transitions order status to "processing"');

    const st2 = await request('PUT', `/orders/${testOrderId}/status`, { status: 'shipped', note: 'Dispatched via local agri-freight' }, farmerToken);
    assert(st2.status === 200, 'Farmer transitions order status to "shipped"');

    const st3 = await request('PUT', `/orders/${testOrderId}/status`, { status: 'delivered', note: 'Received and verified by buyer' }, farmerToken);
    assert(st3.status === 200, 'Farmer transitions order status to "delivered"');

    // Check timeline history
    const timelineRes = await request('GET', `/orders/${testOrderId}/timeline`, null, buyerToken);
    const timelineList = Array.isArray(timelineRes.body) ? timelineRes.body : (timelineRes.body.timeline || []);
    const statuses = timelineList.map(t => t.status);
    assert(statuses.includes('accepted') && statuses.includes('processing') && statuses.includes('shipped') && statuses.includes('delivered'), 'Timeline contains full chronological status audit trail');

    // Verify invalid transition is rejected
    const invalidTrans = await request('PUT', `/orders/${testOrderId}/status`, { status: 'pending' }, farmerToken);
    assert(invalidTrans.status === 400, 'Invalid backward status transition is blocked with 400 Bad Request');

    // TEST 7: Persistent Notifications
    console.log('\n[7/8] Persistent In-App Notifications');
    const farmerNotifs = await request('GET', '/notifications', null, farmerToken);
    const notifList = Array.isArray(farmerNotifs.body) ? farmerNotifs.body : (farmerNotifs.body.notifications || []);
    assert(farmerNotifs.status === 200 && notifList.length > 0, 'Farmer received persistent notification records in database');

    const unreadCountRes = await request('GET', '/notifications/unread-count', null, farmerToken);
    assert(unreadCountRes.body.count > 0, 'Unread notification count calculated accurately');

    const firstNotifId = notifList[0].id;
    const markRead = await request('PUT', `/notifications/${firstNotifId}/read`, {}, farmerToken);
    assert(markRead.status === 200, 'Notification successfully marked as read');

    // TEST 8: AI Marketplace Assistant (Rule-based Fallback & DB produce query)
    console.log('\n[8/8] AI Marketplace Assistant');
    const aiChat = await request('POST', '/assistant/chat', {
      message: 'What crops do you have available under 100 rupees?'
    }, buyerToken);
    assert(aiChat.status === 200 && aiChat.body.reply, 'AI Assistant responds successfully');
    assert(aiChat.body.reply.toLowerCase().includes('mango') || aiChat.body.reply.includes('₹'), 'AI Assistant dynamically referenced actual database produce in its response');

    console.log('\n======================================================');
    console.log(`🎉 ALL ${passedTests}/${totalTests} TESTS PASSED SUCCESSFULLY!`);
    console.log('======================================================\n');

  } catch (err) {
    console.error('\n❌ TEST SUITE ENCOUNTERED AN ERROR:\n', err);
    process.exitCode = 1;
  } finally {
    // Teardown HTTP server and DB connections
    if (server) {
      await new Promise(r => server.close(r));
    }
    // Clean up created test records
    try {
      if (testGbId) await pool.query('DELETE FROM group_buys WHERE id = ?', [testGbId]);
      if (testBidId) await pool.query('DELETE FROM crop_bids WHERE id = ?', [testBidId]);
      if (testOrderId) await pool.query('DELETE FROM orders WHERE id = ?', [testOrderId]);
      if (testCropId) await pool.query('DELETE FROM crops WHERE id = ?', [testCropId]);
      if (farmerUser) {
        await pool.query('DELETE FROM notifications WHERE user_id = ?', [farmerUser.id]);
        await pool.query('DELETE FROM users WHERE id = ?', [farmerUser.id]);
      }
      if (buyerUser) {
        await pool.query('DELETE FROM notifications WHERE user_id = ?', [buyerUser.id]);
        await pool.query('DELETE FROM users WHERE id = ?', [buyerUser.id]);
      }
      console.log('🧹 Cleaned up test database fixtures.');
    } catch (cleanErr) {
      console.warn('Cleanup warning:', cleanErr.message);
    }
    await pool.end();
  }
}

runTests();
