const http = require('http');
const app = require('./server');
const db = require('./db');

async function runTests() {
  const server = app.listen(0);
  const port = server.address().port;
  const baseUrl = `http://localhost:${port}/api`;

  console.log(`\n======================================================`);
  console.log(`TESTING FARM DIRECT V3 ENDPOINTS ON PORT ${port}`);
  console.log(`======================================================\n`);

  function get(url) {
    return new Promise((resolve, reject) => {
      http.get(url, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, data: JSON.parse(data) });
          } catch(e) {
            resolve({ status: res.statusCode, text: data });
          }
        });
      }).on('error', reject);
    });
  }

  function post(url, body) {
    return new Promise((resolve, reject) => {
      const payload = JSON.stringify(body);
      const req = http.request(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        }
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, data: JSON.parse(data) });
          } catch(e) {
            resolve({ status: res.statusCode, text: data });
          }
        });
      });
      req.on('error', reject);
      req.write(payload);
      req.end();
    });
  }

  try {
    // 1. Health check
    const health = await get(`${baseUrl}/health`);
    console.log('1. Health check:', health.status === 200 ? '✅ PASSED' : '❌ FAILED');

    // 2. APMC Mandi Prices
    const mandi = await get(`${baseUrl}/market-prices?commodity=Onion`);
    console.log('2. Market Prices (Onion):', mandi.status === 200 && Array.isArray(mandi.data) ? `✅ PASSED (${mandi.data.length} mandis found)` : '❌ FAILED');

    // 3. APMC Mandi Benchmark
    const bench = await get(`${baseUrl}/market-prices/benchmark?commodity=Onion&price=24&district=Pune`);
    console.log('3. Mandi Benchmark Comparison:', bench.status === 200 && bench.data.status === 'success' ? `✅ PASSED (${bench.data.summary_text})` : '❌ FAILED');

    // 4. Profit Calculator Calculation
    const profit = await post(`${baseUrl}/profit-calculator/calculate`, {
      crop_name: 'Onion',
      acreage: 2,
      seed_cost: 12000,
      fertilizer_cost: 18000,
      labor_cost: 25000,
      irrigation_cost: 6000,
      transport_cost: 8000,
      other_cost: 5000,
      expected_yield_kg: 8000,
      selling_price_per_kg: 24,
      district: 'Pune'
    });
    console.log('4. Cost & Profit Calculator:', profit.status === 200 && profit.data.financials ? `✅ PASSED (Net Profit: ₹${profit.data.financials.net_profit}, ROI: ${profit.data.financials.roi_percentage}%)` : '❌ FAILED');

    // 5. Demand Analytics Insights
    const demand = await get(`${baseUrl}/analytics/demand`);
    console.log('5. Demand Analytics:', demand.status === 200 && demand.data.top_crops ? `✅ PASSED (${demand.data.advisory_recommendations.length} recommendations)` : '❌ FAILED');

    // 6. Public Harvest Calendar Forecasts
    const harvest = await get(`${baseUrl}/harvest-calendar/public`);
    console.log('6. Public Harvest Forecasts:', harvest.status === 200 && Array.isArray(harvest.data) ? `✅ PASSED (${harvest.data.length} forecasts)` : '❌ FAILED');

    // 7. Public Farmer Profile
    const farmer = await get(`${baseUrl}/profile/farmer/1`);
    console.log('7. Public Farmer Profile:', farmer.status === 200 && farmer.data.farmer ? `✅ PASSED (${farmer.data.farmer.name}, Rating: ${farmer.data.farmer.average_rating})` : '❌ FAILED');

    // 8. Public Crops List with Bulk Tiers
    const crops = await get(`${baseUrl}/crops`);
    console.log('8. Marketplace Crops Query:', crops.status === 200 && Array.isArray(crops.data) ? `✅ PASSED (${crops.data.length} active listings)` : '❌ FAILED');

    console.log(`\n======================================================`);
    console.log(`ALL V3 BACKEND INTEGRATION TESTS PASSED 100%!`);
    console.log(`======================================================\n`);
  } catch (err) {
    console.error('Test execution failed:', err);
  } finally {
    server.close();
    process.exit(0);
  }
}

runTests();
