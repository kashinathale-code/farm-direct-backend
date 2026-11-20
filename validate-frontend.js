const fs = require('fs');
const path = require('path');

function checkFile(htmlRel, jsRel) {
  const htmlPath = path.resolve(__dirname, '..', htmlRel);
  const jsPath = path.resolve(__dirname, '..', jsRel);

  if (!fs.existsSync(htmlPath)) {
    console.error('Missing HTML file:', htmlPath);
    return;
  }
  const html = fs.readFileSync(htmlPath, 'utf8');
  console.log(`\nInspecting ${htmlRel} (${html.length} bytes)...`);

  const idRegex = /id=["']([^"']+)["']/g;
  const ids = new Set();
  let m;
  while ((m = idRegex.exec(html)) !== null) {
    ids.add(m[1]);
  }

  if (!fs.existsSync(jsPath)) return;
  const js = fs.readFileSync(jsPath, 'utf8');
  const getElemRegex = /document\.getElementById\(['"]([^'"]+)['"]\)/g;
  const missing = [];
  while ((m = getElemRegex.exec(js)) !== null) {
    const targetId = m[1];
    // Dynamic or conditional containers created at runtime are OK, e.g. toast-container
    if (!ids.has(targetId) && targetId !== 'toast-container') {
      missing.push(targetId);
    }
  }

  const uniqueMissing = [...new Set(missing)];
  if (uniqueMissing.length > 0) {
    console.warn(`  ${jsRel}: ${uniqueMissing.length} IDs called via getElementById not directly in static HTML:`, uniqueMissing);
  } else {
    console.log(`  ${jsRel}: ✅ All referenced element IDs present in HTML!`);
  }
}

checkFile('farm-direct-frontend/farmer-dashboard.html', 'farm-direct-frontend/farmer-dashboard.js');
checkFile('farm-direct-frontend/buyer-dashboard.html', 'farm-direct-frontend/buyer-dashboard.js');
checkFile('farm-direct-frontend/market-prices.html', 'farm-direct-frontend/market-prices.html');
checkFile('farm-direct-frontend/index.html', 'farm-direct-frontend/index.html');
